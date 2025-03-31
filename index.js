/**
 * URL Redirect Checker
 * This script checks if source URLs correctly redirect to their intended destinations.
 * It reads URLs from a CSV file and generates a report of valid and invalid redirects.
 */

const csv = require("csv-parser")
const https = require("https")
const http = require("http")
const fs = require("fs")
const path = require("path")
const { default: inquirer } = require("inquirer")

// Configuration constants
const CONFIG = {
  MAX_REDIRECTIONS: 3,
  MAX_RETRIES: 3,
  INITIAL_BACKOFF: 1000, // 1 second
  REQUEST_TIMEOUT: 10000, // 10 seconds
  CHUNK_SIZE: 8, // Number of concurrent requests
  CHUNK_DELAY: 2000, // Delay between chunks in milliseconds
  DEBUG: false,
  VALID_STATUS_CODES: {
    PERMANENT_REDIRECT: [301, 308], // Only 301 and 308 are valid permanent redirects
  },
  // CSV Configuration
  CSV: {
    COLUMNS: {
      SOURCE: "src", // Column name for source URL
      DESTINATION: "destination", // Column name for destination URL
    },
  },
}

/**
 * Main execution function
 * Reads data from CSV, processes URLs, and generates a report
 */
;(async () => {
  try {
    // Get selected CSV file path
    const selectedFilePath = await selectCsvFile()

    // Update CONFIG with selected file path
    CONFIG.CSV.FILE_PATH = selectedFilePath

    // Process the selected file
    const data = await getData(selectedFilePath)
    const report = {
      result: {
        valid: 0,
        invalid: 0,
        total: 0,
      },
      urls: [],
    }

    await processUrls(data, report)

    // Sort URLs (invalid first) and format them with emojis
    const formattedUrls = report.urls
      .map((url) => ({
        ...url,
        status: url.is_valid ? "✅" : "❌",
      }))
      .sort((a, b) => {
        // Sort invalid first, then by source URL
        if (a.is_valid !== b.is_valid) {
          return a.is_valid ? 1 : -1
        }
        return a.source.localeCompare(b.source)
      })

    const finalReport = {
      result: report.result,
      urls: formattedUrls,
    }

    // Get the report file path based on CSV file name
    const reportFilePath = getReportFilePath(selectedFilePath)
    fs.writeFileSync(reportFilePath, JSON.stringify(finalReport, null, 4))
    console.log(`Report generated successfully at: ${reportFilePath}`)
  } catch (error) {
    console.error("Error in main execution:", error)
    process.exit(1)
  }
})()

/**
 * Process URLs in chunks to avoid overwhelming the system
 * @param {Array} data - Array of URL data from CSV
 * @param {Object} report - Report object to store results
 */
async function processUrls(data, report) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  for (let i = 0; i < data.length; i += CONFIG.CHUNK_SIZE) {
    const chunk = data.slice(i, i + CONFIG.CHUNK_SIZE)
    if (CONFIG.DEBUG) {
      console.log(
        `Processing chunk ${i / CONFIG.CHUNK_SIZE + 1} of ${Math.ceil(
          data.length / CONFIG.CHUNK_SIZE,
        )}`,
      )
    }

    try {
      await Promise.all(
        chunk.map(async (item, index) => {
          const sourceUrl = item[CONFIG.CSV.COLUMNS.SOURCE]
          const destinationUrl = item[CONFIG.CSV.COLUMNS.DESTINATION]

          if (!sourceUrl || !destinationUrl) {
            if (CONFIG.DEBUG) {
              console.warn(
                `Skipping row ${index + 1}: Missing required URLs. Source: ${sourceUrl}, Destination: ${destinationUrl}`,
              )
            }
            return
          }

          const parsedURL = await checkURL(sourceUrl, destinationUrl)
          report.result.total++
          if (parsedURL.is_valid) {
            report.result.valid++
            console.log(
              `✅ Valid redirect: ${sourceUrl} → ${destinationUrl} (${parsedURL.code})`,
            )
          } else {
            report.result.invalid++
            // Build the redirect chain string
            const redirectChain = parsedURL.redirectsList
              .map(
                (redirect, idx) =>
                  `${idx + 1}. ${redirect.location} (${redirect.code})`,
              )
              .join(" → ")

            console.log(
              `❌ Invalid redirect: ${sourceUrl} → ${parsedURL.destination} (${parsedURL.code})\n` +
                `   Expected: ${destinationUrl}\n` +
                `   Redirect chain: ${redirectChain || "No redirects"}`,
            )
          }
          report.urls.push(parsedURL)
        }),
      )
    } catch (error) {
      console.error("Error processing chunk:", error)
    }

    await delay(CONFIG.CHUNK_DELAY)
  }
}

/**
 * Check if a URL correctly redirects to its destination
 * @param {string} src - Source URL to check
 * @param {string} dest_wanted - Expected destination URL
 * @param {number} maxRedirections - Maximum number of redirects to follow
 * @returns {Promise<Object>} Result of the URL check
 */
function checkURL(src, dest_wanted, maxRedirections = CONFIG.MAX_REDIRECTIONS) {
  return new Promise((resolve, reject) => {
    const redirectionsList = []
    let redirectionsCount = 0

    ;(async function check(headers = null) {
      const URLToCheck = headers ? headers.location : src

      if (headers?.location) {
        redirectionsList.push({
          location: headers.location,
          code: headers.statusCode,
        })
        redirectionsCount++
      }

      if (headers !== null && redirectionsCount >= maxRedirections) {
        return resolve({
          code: headers.statusCode,
          source: src,
          dest_wanted: dest_wanted,
          dest_actual: headers.location,
          redirectCounter: redirectionsCount,
          redirectsList: redirectionsList,
          is_valid: false,
        })
      }

      try {
        const headers = await getHeaders(URLToCheck)

        // Continue following redirects if there's a location header,
        // regardless of whether we've found dest_wanted
        if (headers.location) {
          check(headers)
        } else {
          // Only resolve when we reach a non-redirect status
          resolve({
            code: headers.statusCode,
            source: src,
            dest_wanted: dest_wanted,
            dest_actual: URLToCheck,
            redirectCounter: redirectionsCount,
            redirectsList: redirectionsList,
            is_valid: isRedirectValid(
              URLToCheck,
              dest_wanted,
              redirectionsList,
              redirectionsCount,
              headers.statusCode,
            ),
          })
        }
      } catch (error) {
        reject(error)
      }
    }).call(this)
  })
}

/**
 * Check if a redirect is valid based on various criteria
 * @param {string} currentUrl - Current URL being checked
 * @param {string} targetUrl - Expected target URL
 * @param {Array} redirectsList - List of redirects in the chain
 * @param {number} redirectCount - Number of redirects followed
 * @returns {boolean} Whether the redirect is valid
 */
function isRedirectValid(
  currentUrl,
  targetUrl,
  redirectsList,
  redirectCount,
  finalStatusCode,
) {
  // A redirect is valid if:
  // 1. The final destination matches the target URL
  // 2. The first redirect was a permanent redirect (301 or 308)
  // 3. There is exactly one redirection
  // 4. The final status code is 200 (OK)
  return !!(
    currentUrl === targetUrl &&
    redirectCount === 1 &&
    (redirectsList[0]?.code ===
      CONFIG.VALID_STATUS_CODES.PERMANENT_REDIRECT[0] ||
      redirectsList[0]?.code ===
        CONFIG.VALID_STATUS_CODES.PERMANENT_REDIRECT[1]) &&
    finalStatusCode === 200
  )
}

/**
 * Read and parse CSV data
 * @param {string} filePath - Path to the CSV file
 * @returns {Promise<Array>} Array of parsed CSV data
 */
function getData(filePath) {
  return new Promise((resolve, reject) => {
    const results = []

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => {
        // Validate required columns exist
        if (
          !data[CONFIG.CSV.COLUMNS.SOURCE] ||
          !data[CONFIG.CSV.COLUMNS.DESTINATION]
        ) {
          console.warn(
            `Warning: Row missing required columns. Available columns: ${Object.keys(data).join(", ")}`,
          )
        }
        results.push(data)
      })
      .on("end", () => {
        if (results.length === 0) {
          reject(new Error("No data found in CSV file"))
          return
        }
        resolve(results)
      })
      .on("error", (error) => reject(error))
  })
}

/**
 * Get headers for a URL with retry logic
 * @param {string} urlToParse - URL to check
 * @param {number} retryCount - Current retry attempt number
 * @returns {Promise<Object>} Response headers
 */
function getHeaders(urlToParse, retryCount = 0) {
  return new Promise((resolve, reject) => {
    try {
      const parsedURL = new URL(urlToParse)
      const options = {
        protocol: parsedURL.protocol,
        hostname: parsedURL.hostname,
        method: "GET",
        path: parsedURL.pathname + parsedURL.search,
        timeout: CONFIG.REQUEST_TIMEOUT,
      }

      const protocolHandler = parsedURL.protocol === "https:" ? https : http

      const makeRequest = () => {
        const req = protocolHandler.request(options, (res) => {
          res.on("data", () => {})
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode,
              location: res.headers.location || null,
            })
          })
        })

        req.on("error", async (error) => {
          if (
            (error.code === "ENOMEM" || error.code === "ECONNRESET") &&
            retryCount < CONFIG.MAX_RETRIES
          ) {
            const backoffTime = CONFIG.INITIAL_BACKOFF * Math.pow(2, retryCount)
            if (CONFIG.DEBUG) {
              console.log(
                `Retry attempt ${
                  retryCount + 1
                } for ${urlToParse} after ${backoffTime}ms`,
              )
            }
            await new Promise((resolve) => setTimeout(resolve, backoffTime))
            try {
              const result = await getHeaders(urlToParse, retryCount + 1)
              resolve(result)
            } catch (retryError) {
              reject(retryError)
            }
          } else {
            console.error(`Failed to fetch ${urlToParse}:`, error.code)
            reject(error)
          }
        })

        req.end()
      }

      makeRequest()
    } catch (error) {
      if (CONFIG.DEBUG) {
        console.log("Can't parse URL : ", urlToParse)
      }
      reject(error)
    }
  })
}

// Function to list available CSV files and prompt for selection
async function selectCsvFile() {
  const csvDir = path.join(__dirname, "csv")
  try {
    const files = fs.readdirSync(csvDir)
    const csvFiles = files.filter((file) => file.endsWith(".csv"))

    if (csvFiles.length === 0) {
      console.log("No CSV files found in csv directory")
      process.exit(1)
    }

    const answer = await inquirer.prompt([
      {
        type: "list",
        name: "selectedFile",
        message: "Select a CSV file to process:",
        choices: csvFiles,
        pageSize: 10, // Show 10 files at a time if list is long
      },
    ])

    return path.join(csvDir, answer.selectedFile)
  } catch (error) {
    console.error("Error reading csv directory:", error.message)
    process.exit(1)
  }
}

// Add this function to handle report file path
function getReportFilePath(csvFilePath) {
  const csvFileName = path.basename(csvFilePath, ".csv")
  const reportsDir = path.join(__dirname, "reports")

  // Create reports directory if it doesn't exist
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir)
  }

  return path.join(reportsDir, `${csvFileName}.json`)
}
