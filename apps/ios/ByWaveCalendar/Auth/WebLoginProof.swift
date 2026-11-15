import Foundation
import CryptoKit
import Security

struct WebAuthResult {
    let code: String
    let verifier: String
}

enum WebLoginProofError: Error { case invalidServer, invalidCallback, cancelled, expired, randomFailed }

struct WebLoginProof {
    let serverURL: URL
    let scheme: String
    let state: String
    let verifier: String
    let createdAt: Date

    init(serverURL: URL, scheme: String = "bywave") throws {
        let parts = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)
        let loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].contains(serverURL.host?.lowercased() ?? "")
        guard ["bywave", "bywave-staging"].contains(scheme), parts?.host?.isEmpty == false, parts?.user == nil, parts?.password == nil,
              parts?.query == nil, parts?.fragment == nil,
              serverURL.scheme?.lowercased() == "https" || (serverURL.scheme?.lowercased() == "http" && loopback)
        else { throw WebLoginProofError.invalidServer }
        self.serverURL = serverURL
        self.scheme = scheme
        self.state = try Self.random()
        self.verifier = try Self.random()
        self.createdAt = Date()
    }

    static func challenge(_ verifier: String) -> String {
        base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }
    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private static func random() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw WebLoginProofError.randomFailed
        }
        return base64url(Data(bytes))
    }
    var authorizationURL: URL {
        var url = URLComponents(url: serverURL.appendingPathComponent("app/auth/native"), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "state", value: state), URLQueryItem(name: "scheme", value: scheme),
                         URLQueryItem(name: "code_challenge", value: Self.challenge(verifier)),
                         URLQueryItem(name: "code_challenge_method", value: "S256")]
        return url.url!
    }
    func consume(_ url: URL, now: Date = Date()) throws -> WebAuthResult {
        guard now.timeIntervalSince(createdAt) >= 0, now.timeIntervalSince(createdAt) < 600 else { throw WebLoginProofError.expired }
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == scheme, parts.host == "auth", parts.path == "/complete",
              parts.port == nil, parts.user == nil, parts.password == nil, parts.fragment == nil else {
            throw WebLoginProofError.invalidCallback
        }
        let items = parts.queryItems ?? []
        guard items.filter({ $0.name == "state" }).count == 1,
              items.first(where: { $0.name == "state" })?.value == state else { throw WebLoginProofError.invalidCallback }
        let errors = items.filter { $0.name == "error" }
        let codes = items.filter { $0.name == "code" }
        if errors.count == 1, errors[0].value == "access_denied", codes.isEmpty { throw WebLoginProofError.cancelled }
        guard errors.isEmpty, codes.count == 1, let code = codes[0].value,
              code.range(of: "^BW1\\.[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw WebLoginProofError.invalidCallback
        }
        return WebAuthResult(code: code, verifier: verifier)
    }
}
