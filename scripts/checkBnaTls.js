import tls from 'node:tls'

const HOST = 'www.bna.com.ar'
const PORT = 443
const TIMEOUT_MS = 8000

const baseReport = {
  nodeVersion: process.version,
  opensslVersion: process.versions.openssl,
  platform: process.platform,
  host: HOST,
  port: PORT,
  bundledRootCertificateCount: tls.rootCertificates.length,
  nodeExtraCaCertsConfigured: Boolean(process.env.NODE_EXTRA_CA_CERTS),
  nodeOptionsConfigured: Boolean(process.env.NODE_OPTIONS)
}

let completed = false

const finish = (result, exitCode) => {
  if (completed) return
  completed = true
  process.stdout.write(`${JSON.stringify({ ...baseReport, ...result }, null, 2)}\n`)
  process.exitCode = exitCode
}

const socket = tls.connect({
  host: HOST,
  port: PORT,
  servername: HOST,
  rejectUnauthorized: true
})

socket.setTimeout(TIMEOUT_MS)

socket.once('secureConnect', () => {
  const certificate = socket.getPeerCertificate()

  finish(
    {
      authorized: socket.authorized,
      verifyStatus: socket.authorizationError || 'OK',
      tlsProtocol: socket.getProtocol(),
      cipher: socket.getCipher()?.standardName || socket.getCipher()?.name || null,
      subject: certificate?.subject || null,
      issuer: certificate?.issuer || null,
      validFrom: certificate?.valid_from || null,
      validTo: certificate?.valid_to || null
    },
    socket.authorized ? 0 : 1
  )
  socket.end()
})

socket.once('timeout', () => {
  const error = new Error('TLS handshake timeout')
  error.code = 'TLS_HANDSHAKE_TIMEOUT'
  socket.destroy(error)
})

socket.once('error', (error) => {
  finish(
    {
      authorized: false,
      verifyStatus: socket.authorizationError || error.code || 'TLS_HANDSHAKE_FAILED',
      tlsProtocol: socket.getProtocol(),
      cipher: null,
      subject: null,
      issuer: null,
      error: {
        code: error.code || 'TLS_HANDSHAKE_FAILED',
        message: error.message || 'TLS handshake failed'
      }
    },
    1
  )
})
