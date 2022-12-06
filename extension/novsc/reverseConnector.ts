import {
  DebugAdapter,
  DebugAdapterInlineImplementation,
  DebugProtocolMessage,
  Event,
  EventEmitter,
  DebugSession,
} from 'vscode'
import * as net from 'net'
import { UtsExtend } from '../uts'
import { WritableBuffer } from './writableBuffer'

/// Allows debug adapter to reverse-connect to VSCode
export class ReverseAdapterConnector implements DebugAdapter {
  private uts
  private isUts: boolean = false
  private server: net.Server = net.createServer()
  private connection: net.Socket
  private rawData: WritableBuffer = new WritableBuffer()
  private contentLength: number = -1
  private onDidSendMessageEmitter = new EventEmitter<DebugProtocolMessage>()

  constructor(session?: DebugSession) {
    this.isUts = session.configuration.isUts
    if (this.isUts) {
      this.uts = new UtsExtend(
        session.configuration.inputDir,
        session.configuration.outputDir,
        session.configuration.convertFile,
        session.configuration.debugDir,
      )
    }
    this.onDidSendMessage = this.onDidSendMessageEmitter.event
  }

  async listen(port: number = 0): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, '127.0.0.1', () => {
        let address = <net.AddressInfo>this.server.address()
        resolve(address.port)
      })
    })
  }

  async accept(): Promise<void> {
    return new Promise((resolve) => {
      this.server.on('connection', (socket) => {
        this.connection = socket
        socket.on('data', (data) => this.handleData(data))
        resolve()
      })
    })
  }

  readonly onDidSendMessage: Event<DebugProtocolMessage>

  async handleMessage(message: DebugProtocolMessage): Promise<void> {
    let msg = message
    if (this.isUts) {
      msg = await this.uts.messageTransform(msg as any)
    }

    let json = JSON.stringify(msg)
    this.connection.write(
      `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`,
      'utf8',
    )
  }

  private async handleData(data: Buffer): Promise<void> {
    this.rawData.write(data)
    while (true) {
      if (this.contentLength >= 0) {
        if (this.rawData.length >= this.contentLength) {
          let message = this.rawData.head(this.contentLength)
          if (message.length > 0) {
            try {
              let msg: DebugProtocolMessage = JSON.parse(
                message.toString('utf8'),
              )
              if (this.isUts) {
                msg = await this.uts.dataTransform(msg as any)
              }
              this.onDidSendMessageEmitter.fire(msg)
            } catch (err) {
              console.log('Error handling data: ' + err.toString())
            }
          }
          this.rawData.remove(this.contentLength)
          this.contentLength = -1
          continue // there may be more complete messages to process
        }
      } else {
        let idx = this.rawData.contents.indexOf('\r\n\r\n')
        if (idx !== -1) {
          let header = this.rawData.head(idx).toString('utf8')
          let lines = header.split('\r\n')
          for (let i = 0; i < lines.length; i++) {
            const pair = lines[i].split(/: +/)
            if (pair[0] == 'Content-Length') {
              this.contentLength = +pair[1]
            }
          }
          this.rawData.remove(idx + 4)
          continue
        }
      }
      break
    }
  }

  dispose() {
    if (this.connection) this.connection.destroy()
    this.server.close()
  }
}
