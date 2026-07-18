import AppKit
import Foundation
import Vision

enum OCRError: Error {
    case cannotLoadImage(String)
    case cannotCreateCGImage(String)
}

func recognize(path: String) throws -> String {
    guard let image = NSImage(contentsOfFile: path) else {
        throw OCRError.cannotLoadImage(path)
    }
    var rectangle = NSRect(origin: .zero, size: image.size)
    guard let cgImage = image.cgImage(
        forProposedRect: &rectangle,
        context: nil,
        hints: nil
    ) else {
        throw OCRError.cannotCreateCGImage(path)
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["en-US"]
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])
    return (request.results ?? [])
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
}

var pages: [String] = []
for path in CommandLine.arguments.dropFirst() {
    do {
        pages.append(try recognize(path: path))
    } catch {
        fputs("OCR error for \(path): \(error)\n", stderr)
    }
}
print(pages.joined(separator: "\n\n--- PAGE BREAK ---\n\n"))
