import { app } from 'electron'
import fs from 'fs'
import { spawn } from 'child_process'
import { releaseTarballUrl } from './releases.js'
import { downloadTarball } from './github.js'
import os from 'os'
import {
  delimiter,
  dirname
} from 'path'
import { decompress } from 'targz'
import waitPort from 'wait-port'

/**
 * Hostname for websockets URL. Not used for binding,
 * which is always to `0.0.0.0:38397`.
 */
const defaultBind = {
  host: '127.0.0.1',
  port: 38397
}
const wsUrl = `ws://${defaultBind.host}:${defaultBind.port}`

const userDir = getUserDir()

const executableName = (os.platform() === 'win32') ? 'fernspielapparat.exe' : 'fernspielapparat'

/**
 * Describes a fernspielapparat runtime running in a child process,
 * with a server bound to a returned URL.
 *
 * @typedef Runtime
 * @property {import('child_process').ChildProcess} process - Child process running a server-enabled runtime
 * @property {string} url - URL to the running WebSocket server for remote control
 */

/**
 * Spawns a process for the fernspielapparat runtime.
 *
 * The executable is searched for in this applications user dir.
 * If it is not found, a recent version is downloaded from GitHub.
 *
 * Returns a promise for a runtime child process in server mode,
 * bound to `0.0.0.0:38397`, which is the default configuration.
 *
 * @returns {Promise<Runtime>} promise for runtime process
 */
export default function launchRuntime () {
  return getBinary()
    .catch(downloadBinary)
    .then(launchServer)
}

/**
 * Checks for the newest binary release of the fernspielapparat runtime.
 * If a newer one is available, downloads it and returns a path to it.
 * If an already downloaded release is the most recent, returns a path to it.
 *
 * @returns {Promise<string>} promise for a binary path
 */
function getBinary () {
  return fernspielapparatVersionOnPath()
    .then(
      // Prefer system-provided binary
      fernspielapparatOnPath,
      // Not on path, check if already installed by `weichspielapparat` and use that
      fernspielapparatPathInUserDir
    )

  function fernspielapparatOnPath (version) {
    console.log(`using system-provided fernspielapparat runtime, version ${version}`)
    return executableName
  }
}

/**
 * Tries to start a child process running the fernspielapparat runtime
 * and resolves to a running child process instance.
 *
 * If no path is specified or if the path is `"fernspielapparat"` or `"fernspielapparat.exe"`,
 * then the runtime on the path is used.
 *
 * If an absolute path to a runtime executable is specified this one is
 * used.
 *
 * The runtime is bound to `0.0.0.0:38397`, which is the default configuration.
 *
 * @param {string} pathToBinary Either an absolute path to a binary or `'fernspielapparat'` to use the PATH
 * @returns {Promise<Runtime} promise for running child process with a specified ws URL
 */
function launchServer (pathToBinary) {
  return new Promise((resolve, reject) => {
    let starting = true
    const args = [
      '-vvvv', // print debug and info logs on stderr, not only warnings and errors
      '-s' // start in server mode
    ]
    const env = envForPlatform()
    const opts = { env }

    if (pathToBinary && pathToBinary !== 'fernspielapparat' && pathToBinary !== 'fernspielapparat.exe') {
      // change working directory to where the executable is,
      // and leave it unchanged if version on path is used
      // changing wd works around incompatibility with spaces on windows
      // See: https://github.com/nodejs/node-v0.x-archive/issues/25895
      opts.cwd = dirname(pathToBinary)
    }

    const server = spawn(
      executableName,
      args,
      opts
    )

    server.stdout.on('data', (data) => {
      console.log(data.toString())
    })
    server.stderr.on('data', (data) => {
      console.error(data.toString())
    })

    server.on('exit', (code) => {
      if (code) {
        console.log(`server exited with code ${code}`)
      } else {
        console.log('server exited')
      }

      if (starting) {
        starting = false
        reject(new Error(`fernspielapparat unexpected exit at startup with code ${code}`))
      }
    })
    server.on('error', (err) => {
      reject(new Error(`fernspielapparat could not be started, error: ${err.message}`))
    })

    waitPort(
      {
        ...defaultBind,
        // wait 150ms before each connection attempt
        timeout: 150
      },
      5000 // wait max 5sec for successful server startup
    ).then(
      () => done(),
      () => reject(new Error(
        `fernspielapparat server not available on port ${defaultBind.port} after 5 seconds, giving up.`
      ))
    )

    function done () {
      resolve({
        process: server,
        url: wsUrl
      })
    }
  })
}

function fernspielapparatVersionOnPath () {
  return new Promise((resolve, reject) => {
    const server = spawn(
      executableName,
      [
        '--version' // only print version and then exit
      ],
      {
        env: envForPlatform()
      }
    )
    let output = ''
    server.stdout.on('data', (data) => {
      output += data
    })
    server.stderr.on('data', (data) => {
      output += data
    })
    server.on('error', (err) => {
      reject(new Error(`No fernspielapparat on path, error: ${err.message}`))
    })
    server.on('exit', (code) => {
      if (code) {
        reject(new Error(`Unsuccessful exit status: ${code}, Output: "${output}"`))
      } else {
        const outputWords = output.split(' ')

        if (outputWords.length === 2) {
          const version = output.split(' ')[1].trim() // parse "fernspielapparat 0.1.0"
          resolve(version)
        } else {
          console.log(`Unexpected output from fernspielapparat runtime: ${output}`)
          reject(new Error(`Unexpected output from fernspielapparat runtime: ${output}`))
        }
      }
    })
  })
}

function fernspielapparatPathInUserDir () {
  const binaryPath = userBinaryPath()
  // must be able to update (write), and execute (read + execute)
  const perms = (os.platform() === 'win32') ? (fs.constants.R_OK) : (fs.constants.R_OK | fs.constants.X_OK)

  return new Promise((resolve, reject) => {
    fs.access(binaryPath, perms, (err) => {
      if (err) {
        reject(new Error(`Lacking execution permissions for runtime binary at: ${binaryPath}, error: ${err.message}`))
      } else {
        console.log(`using previously downloaded runtime ${binaryPath}`)
        resolve(binaryPath)
      }
    })
  })
}

/**
 * Gets the absolute path where the runtime binary would be stored for this user
 * if `downloadBinary` has been called prior to the call and the binary has not
 * been manually deleted.
 *
 * @returns {string} path in userdir where binaries are downloaded to
 */
function userBinaryPath () {
  // FIXME this kinda sounds like a huge security hole - an attacker could manipulate the directory
  //       maybe downloading it every time into an unnamed file would be better?
  return `${userDir}/${executableName}`
}

/**
 * Downloads a fernspielapparat binary from GitHub and places it
 * in the user directory.
 *
 * @returns {Promise<string>} a promise for the downloaded binary in the user dir
 */
function downloadBinary () {
  return releaseTarballUrl()
    .then(url => downloadTarball(url, `fernspielapparat.tar.gz`))
    .then(extractExecutableToUserDir)
}

function extractExecutableToUserDir (tarPath) {
  return new Promise((resolve, reject) => {
    let binary
    decompress({
      src: tarPath,
      dest: userDir,
      tar: {
        ignore: file => {
          const isExecutable = !!(/fernspielapparat$/.test(file) || /fernspielapparat.exe$/.test(file))
          if (isExecutable) {
            binary = file
          }
          return !isExecutable
        },
        map: header => {
          if (/fernspielapparat$/.test(header.name)) {
            header.name = 'fernspielapparat'
          } else if (/fernspielapparat.exe$/.test(header.name)) {
            header.name = 'fernspielapparat.exe'
          } else {
            header = null // ignore the other files
          }

          return header
        }
      }
    }, (err) => {
      if (err) {
        const msg = err.message || err
        reject(new Error(`Failed to decompress release, error: ${msg}.`))
      } else if (!binary) {
        reject(new Error('Could not find executable in tarball'))
      } else {
        console.log(`extracted binary: ${binary}`)
        resolve(binary)
      }
    })
  })
}

/**
 * Asks electron for the `userData` directory and throws an error if it
 * did not work.
 *
 * @returns {string} a directory to store persistent data for this user
 */
function getUserDir () {
  const userDir = app.getPath('userData')
  if (!userDir) {
    throw new Error('Could not find userData directory')
  }
  return userDir
}

function envForPlatform () {
  const env = {
    ...process.env
  }

  const vlcRegex = /vlc/i
  const platform = os.platform()
  if (platform === 'darwin') {
    // Set DYLD_PATH and vlc plugin dir if not set by user
    if (!vlcRegex.exec(env.DYLD_LIBRARY_PATH)) {
      const prefix = env.DYLD_LIBRARY_PATH
        ? `${env.DYLD_LIBRARY_PATH}${delimiter}`
        : ''
      env.DYLD_LIBRARY_PATH = `${prefix}${vlcLibDir()}`
    }
    // And plugin dir
    if (!env.VLC_PLUGIN_PATH) {
      env.VLC_PLUGIN_PATH = vlcPluginDir()
    }
  } else if (platform === 'win32') {
    if (!vlcRegex.exec(env.Path)) {
      // No VLC on the path, guess where it is and add it to the path
      env.Path = `${env.Path}${delimiter}${vlcLibDir()}`
    }

    if (!env.VLC_PLUGIN_PATH) {
      env.VLC_PLUGIN_PATH = vlcPluginDir()
    }
  }

  return env
}

function vlcPluginDir () {
  const platform = os.platform()
  if (platform === 'darwin') {
    return '/Applications/VLC.app/Contents/MacOS/plugins'
  } else if (platform === 'win32') {
    return `${process.env.ProgramFiles}\\VideoLAN\\VLC\\plugins`
  } else {
    return ''
  }
}

function vlcLibDir () {
  const platform = os.platform()
  if (platform === 'darwin') {
    // without the lib, the loader searches in that subdirectory automatically
    return '/Applications/VLC.app/Contents/MacOS:/Applications/VLC.app/Contents/MacOS/lib'
  } else if (platform === 'win32') {
    return `${process.env.ProgramFiles}\\VideoLAN\\VLC`
  } else {
    return ''
  }
}
