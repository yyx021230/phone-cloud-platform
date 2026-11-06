import CoreGraphics
import Foundation
import ImageIO
import Vision

struct Input: Decodable {
    let lead: String
    let phone: String
    let frames: [String]
}

struct RecognizedLine {
    let text: String
    let box: CGRect
}

func hasBadgeBackground(_ image: CGImage, around box: CGRect) -> Bool {
    let width = 120, height = 240
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    return pixels.withUnsafeMutableBytes { bytes in
        guard let context = CGContext(data: bytes.baseAddress, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let samples = [(box.minX - 0.055, box.midY), (box.maxX + 0.055, box.midY),
                       (box.minX - 0.055, box.midY + 0.055), (box.maxX + 0.055, box.midY + 0.055)]
        return samples.allSatisfy { x, y in
            guard (0..<1).contains(x), (0..<1).contains(y) else { return false }
            let offset = (Int((1 - y) * Double(height)) * width + Int(x * Double(width))) * 4
            let colors = [bytes[offset], bytes[offset + 1], bytes[offset + 2]].map(Int.init)
            guard let darkest = colors.min(), let lightest = colors.max() else { return false }
            return darkest >= 65 && lightest <= 180 && lightest - darkest <= 22
        }
    }
}

func matches(_ path: String, lead: String, phone: String) throws -> Bool {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return false }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    let lines = (request.results ?? []).compactMap { observation -> RecognizedLine? in
        guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.9 else { return nil }
        let normalized = candidate.string.precomposedStringWithCompatibilityMapping
            .components(separatedBy: .whitespacesAndNewlines).joined()
        return RecognizedLine(text: normalized, box: observation.boundingBox)
    }
    guard lines.contains(where: { $0.text == lead && $0.box.midY > 0.64 }),
          lines.contains(where: { $0.text == phone || $0.text == "电话" + phone }),
          lines.contains(where: { $0.text == "添加为联系人" && $0.box.midY < 0.13 }) else { return false }
    let badges = lines.filter { line in
        line.text == "已发送" && (0.45...0.55).contains(line.box.midX)
            && (0.38...0.51).contains(line.box.midY) && (0.07...0.22).contains(line.box.width)
    }
    return badges.count == 1 && hasBadgeBackground(image, around: badges[0].box)
}

let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
guard input.lead.range(of: "^[1-9][0-9]{0,18}$", options: .regularExpression) != nil,
      input.phone.range(of: "^1[3-9][0-9]{9}$", options: .regularExpression) != nil,
      (2...12).contains(input.frames.count), Set(input.frames).count == input.frames.count else { exit(2) }
var consecutive = 0
for path in input.frames {
    if try matches(path, lead: input.lead, phone: input.phone) {
        consecutive += 1
        if consecutive == 2 { print("confirmed"); exit(0) }
    } else { consecutive = 0 }
}
print("unconfirmed")
