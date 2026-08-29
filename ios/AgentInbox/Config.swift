import Foundation

enum Config {
    /// The relay this build talks to. Set it and a tester never types an
    /// address — an invite code, or the link, is the whole sign-up.
    ///
    /// Empty means "ask", which is what local development wants.
    static let defaultRelayURL = "https://relay-production-cc96.up.railway.app"

    /// Shown on the first screen so people know where they are joining.
    static var hasDefaultRelay: Bool { !defaultRelayURL.isEmpty }
}
