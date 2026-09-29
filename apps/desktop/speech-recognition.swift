import AVFoundation
import Foundation
import Speech
import Darwin

let locale = CommandLine.arguments.dropFirst().first ?? "zh-CN"
var audioEngine: AVAudioEngine?
var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
var recognitionTask: SFSpeechRecognitionTask?
var signalSource: DispatchSourceSignal?
var finished = false

func emit(_ payload: [String: String]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload), let line = String(data: data, encoding: .utf8) else { return }
  print(line)
  fflush(stdout)
}

func finish(code: Int32 = 0) {
  guard !finished else { return }
  finished = true
  audioEngine?.inputNode.removeTap(onBus: 0)
  audioEngine?.stop()
  recognitionRequest?.endAudio()
  recognitionTask?.cancel()
  exit(code)
}

func beginRecognition() {
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
    emit(["type": "error", "message": "macOS Speech Recognition is unavailable for this language."])
    finish(code: 1)
    return
  }
  guard recognizer.isAvailable else {
    emit(["type": "error", "message": "macOS Speech Recognition is temporarily unavailable. Try again in a moment."])
    finish(code: 1)
    return
  }

  let engine = AVAudioEngine()
  let request = SFSpeechAudioBufferRecognitionRequest()
  request.shouldReportPartialResults = true
  if #available(macOS 13.0, *) { request.addsPunctuation = true }
  audioEngine = engine
  recognitionRequest = request

  let input = engine.inputNode
  let format = input.outputFormat(forBus: 0)
  input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
    request.append(buffer)
  }

  recognitionTask = recognizer.recognitionTask(with: request) { result, error in
    if let result {
      let type = result.isFinal ? "final" : "partial"
      emit(["type": type, "text": result.bestTranscription.formattedString])
      if result.isFinal { finish() }
    }
    if let error {
      emit(["type": "error", "message": "macOS could not understand that request: \(error.localizedDescription)"])
      finish(code: 1)
    }
  }

  do {
    engine.prepare()
    try engine.start()
    emit(["type": "ready"])
  } catch {
    emit(["type": "error", "message": "Chatty could not access the microphone: \(error.localizedDescription)"])
    finish(code: 1)
  }
}

signal(SIGTERM, SIG_IGN)
signalSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signalSource?.setEventHandler { finish() }
signalSource?.resume()

SFSpeechRecognizer.requestAuthorization { status in
  DispatchQueue.main.async {
    guard status == .authorized else {
      emit(["type": "error", "message": "Allow Speech Recognition for Chatty in macOS Settings, then try again."])
      finish(code: 1)
      return
    }
    beginRecognition()
  }
}

RunLoop.main.run()
