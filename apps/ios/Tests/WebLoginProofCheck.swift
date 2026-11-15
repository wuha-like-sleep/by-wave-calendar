import Foundation

@main struct WebLoginProofCheck {
    static func fails(_ action: () throws -> Void) {
        do { try action(); fatalError("Expected callback rejection") } catch { }
    }
    static func main() throws {
        precondition(WebLoginProof.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        let proof = try WebLoginProof(serverURL: URL(string: "https://calendar.example")!)
        let code = "BW1." + String(repeating: "a", count: 43)
        let callback = "bywave://auth/complete?state=\(proof.state)&code=\(code)"
        precondition(!proof.authorizationURL.absoluteString.contains(proof.verifier))
        let result = try proof.consume(URL(string: callback)!)
        precondition(result.code == code && result.verifier == proof.verifier)
        for bad in [callback + "&state=\(proof.state)", callback + "&code=\(code)", callback + "#fragment", callback.replacingOccurrences(of: "//auth", with: "//evil"), callback.replacingOccurrences(of: proof.state, with: "bad"), callback.replacingOccurrences(of: code, with: "ABC123")] {
            fails { _ = try proof.consume(URL(string: bad)!) }
        }
        fails { _ = try proof.consume(URL(string: callback)!, now: proof.createdAt.addingTimeInterval(601)) }
        fails { _ = try WebLoginProof(serverURL: URL(string: "http://calendar.example")!) }
        fails { _ = try WebLoginProof(serverURL: URL(string: "https://user:pass@calendar.example")!) }
        print("WebLoginProof: PKCE, callback binding, duplicate parameters, expiry and HTTPS checks passed")
    }
}
