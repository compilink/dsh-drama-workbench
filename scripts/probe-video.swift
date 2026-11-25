// macOS-only, local full decode. No network, account access, or publishing.
import AVFoundation
import Foundation
let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let videos = asset.tracks(withMediaType: .video), audios = asset.tracks(withMediaType: .audio)
var result: [String: Any] = ["videoTracks": videos.count, "audioTracks": audios.count]
if let track = videos.first {
 let reader = try AVAssetReader(asset: asset)
 let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
 reader.add(output); reader.startReading()
 var count = 0, end = 0.0
 while let s = output.copyNextSampleBuffer() { count += 1; let duration = CMTimeGetSeconds(CMSampleBufferGetDuration(s)); end = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(s)) + (duration.isFinite && duration > 0 ? duration : 1.0 / Double(max(track.nominalFrameRate, 1))) }
 result["videoSeconds"] = CMTimeGetSeconds(track.timeRange.duration)
 result["decodedFrames"] = count; result["decodedVideoEnd"] = end
 result["videoComplete"] = reader.status == .completed
 if let error = reader.error { result["videoDecoderError"] = error.localizedDescription }
}
if let track = audios.first {
 let reader = try AVAssetReader(asset: asset)
 let output = AVAssetReaderTrackOutput(track: track, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false])
 reader.add(output); reader.startReading()
 let duration = CMTimeGetSeconds(asset.duration)
 var energy = [Double](repeating: 0, count: 5), counts = [Int](repeating: 0, count: 5), peak = Float(0), end = 0.0
 while let s = output.copyNextSampleBuffer() {
  let time = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(s)), span = CMTimeGetSeconds(CMSampleBufferGetDuration(s)); end = time + span
  if let block = CMSampleBufferGetDataBuffer(s) {
   var length = 0; var ptr: UnsafeMutablePointer<Int8>?
   CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &ptr)
   if let p = ptr { p.withMemoryRebound(to: Float.self, capacity: length / 4) { f in
    for j in 0..<length/4 { let x = f[j], t = time + span * Double(j) / Double(length/4); let i = min(4, max(0, Int(t / max(duration, 0.01) * 5))); energy[i] += Double(x*x); counts[i] += 1; peak = max(peak, abs(x)) }
   } }
  }
 }
 result["audioSeconds"] = CMTimeGetSeconds(track.timeRange.duration); result["decodedAudioEnd"] = end
 result["audioComplete"] = reader.status == .completed
 if let error = reader.error { result["audioDecoderError"] = error.localizedDescription }
 result["rms"] = zip(energy, counts).map { $1 > 0 ? sqrt($0 / Double($1)) : 0 }
 result["peak"] = peak
}
let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
FileHandle.standardOutput.write(data)
