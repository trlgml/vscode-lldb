import { basename, join, resolve } from 'path'

const requireFunc =
  typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require

interface Imessage {
  command: string
  seq: string
  arguments: {
    lines: any[]
    breakpoints: any[]
    source: {
      name: string
      path: string
    }
  }
}

interface istackFrame {
  line: string
  column: string
  name: string
  source: {
    name?: string
    path?: string
    sourceReference?: number
  }
}
enum dataEnum {
  'event' = 'event',
  'response' = 'response',
}
interface Idata {
  command: string
  event: string
  request_seq: string
  type: dataEnum
  body: {
    stackFrames: istackFrame[]
  }
}
export class UtsExtend {
  private inputDir: string
  private outputDir: string
  private debugDir: string
  private breakpointMap: Map<string, any>
  private breakpointEventMap: Map<string, any>
  private sourceMap: Map<string, any>
  private uts: any

  constructor(
    inputDir: string,
    outputDir: string,
    convertFile: string,
    debugDir: string,
  ) {
    this.outputDir = outputDir
    this.inputDir = inputDir
    this.debugDir = debugDir
    this.uts = requireFunc(convertFile)
    this.breakpointEventMap = new Map()
    this.breakpointMap = new Map()
    this.sourceMap = new Map()
  }
  private formatToHump = (value: string): string => {
    return value.replace(/\-(\w)/g, (_, letter) => letter.toUpperCase())
  }
  private formatToLine = (value: string): string => {
    value = value.substring(0, 1).toLowerCase() + value.substring(1)
    return value.replace(/([A-Z])/g, '-$1').toLowerCase()
  }
  private isSwift = (file: string): boolean => {
    return /swift$/.test(file)
  }
  private uniUtsSdkModule = (file: string): string => {
    const modRegex = /[\/|\\]uni_modules[\/|\\](.*?)[\/|\\]/
    const [, modPk] = modRegex.exec(file) || []
    if (modPk) {
      return join('uni_modules', modPk, 'utssdk')
    }
    const sdkRegex = /[\/|\\]utssdk[\/|\\](.*?)[\/|\\]/
    const [, sdkPk] = sdkRegex.exec(file) || []
    if (sdkPk) {
      return join('utssdk', sdkPk)
    }
    return ''
  }
  private uniUtsSdkUnpackage = (file: string): string => {
    const regex = /[\/|\\]uni_modules[\/|\\](.*?)[\/|\\].*src[\/|\\]index\.swift/
    const [, modPk] = regex.exec(file) || []
    if (modPk) {
      return join('uni_modules', modPk, 'utssdk')
    }
    const sdkRegex = /[\/|\\]utssdk[\/|\\](.*?)[\/|\\].*src[\/|\\]index\.swift/
    const [, sdkPk] = sdkRegex.exec(file) || []
    if (sdkPk) {
      return join('utssdk', sdkPk)
    }
    return ''
  }
  // debug路径 -> unpackage/index.swift
  private toUnpackageFile(file: string) {
    const path = resolve(
      this.outputDir,
      this.uniUtsSdkUnpackage(file),
      './app-ios/index.swift',
    )
    return path
  }

  // index.swift.map -> debug路径
  private toDebugFileByUts(file: string): string {
    const path = resolve(
      this.debugDir,
      this.uniUtsSdkModule(file),
      './app-ios/src/index.swift',
    )
    return path
  }
  private resolveUtsPluginSourceMapFile({ filename }: any) {
    try {
      const sourceMapFile = this.uts.resolveUtsPluginSourceMapFile(
        'swift',
        filename,
        this.inputDir,
        this.outputDir,
      )
      return sourceMapFile
    } catch (error) {
      return ''
    }
  }
  private async generatedPositionFor({ sourceMapFile, filename, line }: any) {
    try {
      const res = await this.uts.generatedPositionFor({
        sourceMapFile,
        filename,
        outputDir: this.outputDir,
        line,
        column: 0,
      })

      res.path = this.toDebugFileByUts(sourceMapFile)
      return res
    } catch (error) {
      return false
    }
  }
  private async originalPositionFor({ sourceMapFile, filename, line }: any) {
    try {
      const res = await this.uts.originalPositionFor({
        sourceMapFile,
        filename,
        line,
        column: 0,
      })
      res.path = resolve(this.inputDir, res.source)
      return res
    } catch (error) {
      return false
    }
  }

  public async messageTransform(message: Imessage) {
    const TransformEnum: Record<string, any> = {
      source: async (data: any) => {
        this.sourceMap.set(data.seq, true)
        return data
      },
      setBreakpoints: async (message: Imessage) => {
        const {
          arguments: {
            breakpoints,
            source: { path },
          },
          seq,
        } = message
        const sourceMapFile = this.resolveUtsPluginSourceMapFile({
          filename: path,
        })
        if (!sourceMapFile) return message
        message.arguments.breakpoints = await Promise.all(
          breakpoints.map(async (bp) => {
            const res = await this.generatedPositionFor({
              sourceMapFile,
              filename: path,
              line: bp.line,
            })
            if (res) {
              bp.line = res.line
            }
            return bp
          }),
        )
        message.arguments.lines = message.arguments.breakpoints.map(
          ({ line }) => line,
        )
        const debugFile = this.toDebugFileByUts(sourceMapFile)
        message.arguments.source = {
          name: basename(debugFile),
          path: debugFile,
        }
        this.breakpointMap.set(seq, {
          utsfile: path,
          unpacakgeFile: this.toUnpackageFile(debugFile),
          debugFile: debugFile,
          sourceMapFile,
        })
        return message
      },
    }
    try {
      const TransformFunction = TransformEnum[message.command]
      if (TransformFunction) {
        return TransformFunction(message)
      }
      return message
    } catch (error) {
      return message
    }
  }
  public async dataTransform(data: Idata) {
    const TransformEnum: Record<string, any> = {
      stackTrace: async (data: Idata) => {
        data.body.stackFrames = await Promise.all(
          data.body.stackFrames.map(async (stackFrame: istackFrame) => {
            const {
              source: { path },
            } = stackFrame
            if (stackFrame?.source?.name.includes('<compiler-generated>')) {
              stackFrame.source = Object.assign(stackFrame.source, {
                sourceReference: 0,
                name: stackFrame.name,
              })
              // stackFrame.name = 'delete'
              return stackFrame
            }
            if (path && this.isSwift(path)) {
              const filename = this.toUnpackageFile(path)
              const sourceMapFile = this.resolveUtsPluginSourceMapFile({
                filename,
              })
              if (!sourceMapFile) return stackFrame
              const res = await this.originalPositionFor({
                sourceMapFile,
                filename,
                line: stackFrame.line,
                column: stackFrame.column,
              })
              if (res) {
                stackFrame.line = res.line
                stackFrame.column = res.column
                stackFrame.source = {
                  name: basename(res.path),
                  path: res.path,
                }
              } else {
                stackFrame.source = Object.assign(stackFrame.source, {
                  sourceReference: 0,
                  path: stackFrame.name,
                })
              }
            } else {
              // stackFrame.source.path = stackFrame.name
            }
            console.log(stackFrame)
            return stackFrame
          }),
        )
        data.body.stackFrames = data.body.stackFrames.filter(
          (stackFrame) => stackFrame?.name !== 'delete',
        )
        return data
      },
      breakpoint: async (data: any) => {
        const bp = data.body.breakpoint
        const source = this.breakpointEventMap.get(bp.id)
        if (source) {
          const res = await this.originalPositionFor({
            sourceMapFile: source.sourceMapFile,
            filename: source.unpacakgeFile,
            line: bp.line,
          })
          if (res) {
            bp.line = res.line
            data.body.breakpoint = bp
          }
        }
        return data
      },
      setBreakpoints: async (data: any) => {
        const source = this.breakpointMap.get(data.request_seq)
        if (source) {
          data.body.breakpoints = await Promise.all(
            data.body.breakpoints.map(async (bp: any) => {
              if (bp.line) {
                const res = await this.originalPositionFor({
                  sourceMapFile: source.sourceMapFile,
                  filename: source.unpacakgeFile,
                  line: bp.line,
                })
                if (res) {
                  bp.line = res.line
                }
              }
              this.breakpointEventMap.set(bp.id, source)
              return bp
            }),
          )
        }
        return data
      },
      emptyCommand: async (data: any) => {
        // if (this.sourceMap.get(data.request_seq) && data.message === 'Internal debugger error: Expected non-zero handle value') {
        if (this.sourceMap.get(data.request_seq)) {
          return {
            seq: data.seq,
            type: 'response',
            request_seq: data.request_seq,
            success: true,
            command: 'source',
            body: {
              content: `/*
uts 转换出错啦
								*/
`,
            },
          }
        }
      },
    }

    try {
      let key = data.command || 'emptyCommand'
      if (data.type === dataEnum.event) {
        key = data.event
      }
      const TransformFunction = TransformEnum[key]
      if (TransformFunction) {
        return TransformFunction(data)
      }
      return data
    } catch (error) {
      return data
    }
  }
}
