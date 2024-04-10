const csv = require('csv-parser')
const https = require('https')
const http = require('http')
const fs = require('fs')

;(async () => {
  const data = await getData()
  const report = {
    result: {
      valid: 0,
      invalid: 0,
      total: 0
    },
    urls: []
  }
  await asyncForEach(data, async (line) => {
    const parsedURL = await checkURL(line.src, line.destination)
    report.result.total++
    if (parsedURL.is_valid) {
      report.result.valid++
    } else {
      report.result.invalid++
    }
    report.urls.push(parsedURL)
  })

  fs.writeFileSync('report.json', JSON.stringify(report, null, 4))
})()

function checkURL (src, destination, maxRedirections = 3) {
  return new Promise((resolve, reject) => {
    const redirectionsList = []
    let redirectionsCount = 0

    ;(async function check (headers = null) {
      // we follow redirections
      const URLToCheck = headers ? headers.location : src

      if (headers && headers.location) {
        redirectionsList.push({
          location: headers.location,
          code: headers.statusCode
        })
        redirectionsCount++
      }

      // we stop the process if the maximum number of redirections is reached
      if (headers !== null && redirectionsCount >= maxRedirections) {
        return resolve({
          code: headers.statusCode,
          source: src,
          target: destination,
          destination: headers.location,
          redirectCounter: redirectionsCount,
          redirectsList: redirectionsList,
          is_valid: false
        })
      }

      getHeaders(URLToCheck).then((headers) => {
        console.log({
          urlToCheck: URLToCheck,
          target: destination,
          location: headers.location,
          code: headers.statusCode,
          redirectionsCount: redirectionsCount,
          is_valid: !!((destination === URLToCheck && headers.statusCode >= 200 && headers.statusCode <= 301) && redirectionsCount <= 1),
          test1: headers.location !== null && destination !== headers.location,
          test2: URLToCheck === destination
        })

        // if we need to follow redirection
        if (headers.location && URLToCheck !== destination) {
          check(headers)
        } else {
          resolve({
            code: headers.statusCode,
            source: src,
            target: destination,
            destination: URLToCheck,
            redirectCounter: redirectionsCount,
            redirectsList: redirectionsList,
            is_valid: !!((URLToCheck === destination && headers.statusCode >= 200 && headers.statusCode <= 301) && redirectionsCount <= 1)
          })
        }
      })
    }).call(this)
  })
}

function getData () {
  return new Promise((resolve, reject) => {
    const results = []

    fs.createReadStream('redirections.csv')
      .pipe(csv())
      .on('headers', (headers) => {
        // console.log(headers)
      })
      .on('data', (data) => results.push(data))
      .on('end', () => {
        resolve(results)
      })
  })
}

function getHeaders (urlToParse) {
  return new Promise((resolve, reject) => {
    try {
      const parsedURL = new URL(urlToParse)
      const options = {
        protocol: parsedURL.protocol,
        hostname: parsedURL.hostname,
        method: 'GET', // Change method to GET
        path: parsedURL.pathname + parsedURL.search // Include search part for query parameters
      }

      const protocolHandler = parsedURL.protocol === 'https:' ? https : http

      const req = protocolHandler.request(options, (res) => {
        // Consume response body to avoid memory issues but ignore its content
        res.on('data', () => {})
        res.on('end', () => {
          // Resolve the promise when the response has been fully consumed
          resolve({
            statusCode: res.statusCode,
            location: res.headers.location || null
          })
        })
      })
      req.on('error', (error) => {
        reject(error)
      })
      req.end()
    } catch (error) {
      console.log('Can\'t parse URL : ', urlToParse)
      reject(error)
    }
  })
}

async function asyncForEach (array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
}
