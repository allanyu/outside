import Foundation

/// The user is a participant in every thread and always has this id.
let userID = "user"

struct Agent: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var avatarEmoji: String
    var status: String
    var lastSeen: Int
    /// Present for agents added from the app. Agents that registered with the
    /// shared relay token (the echo adapter, say) have none.
    var connectToken: String?
    /// Set when this agent is served over another agent's connection, so it
    /// needed no setup wherever that agent runs.
    var hostId: String?
    /// Which of the host's personas answers as this agent.
    var profile: String?
    /// Personas this agent reported it can answer as (Hermes profiles, say).
    var availableProfiles: [String]?

    var isOnline: Bool { status == "online" }
    var hasConnectToken: Bool { !(connectToken ?? "").isEmpty }
    var isHosted: Bool { !(hostId ?? "").isEmpty }
    /// Can other agents be created to run on this one's connection?
    var canHost: Bool { !isHosted }
}

struct Attachment: Codable, Identifiable, Hashable {
    let id: String
    let url: String
    let mime: String

    var isImage: Bool { mime.hasPrefix("image/") }
}

struct Message: Codable, Identifiable, Hashable {
    let id: String
    let threadId: String
    let senderId: String
    var text: String
    var attachments: [Attachment]
    var mentions: [String]
    var replyTo: String?
    var kind: String
    var createdAt: Int

    var isFromUser: Bool { senderId == userID }
    var isApproval: Bool { kind == "approval" }
    var date: Date { Date(timeIntervalSince1970: Double(createdAt) / 1000) }
}

/// Named ChatThread so it does not collide with Foundation.Thread.
struct ChatThread: Codable, Identifiable, Hashable {
    let id: String
    var kind: String
    var name: String?
    var participantIds: [String]
    var createdAt: Int
    var messages: [Message]?

    var isDM: Bool { kind == "dm" }
    var agentIds: [String] { participantIds.filter { $0 != userID } }
}

struct Approval: Codable, Identifiable, Hashable {
    let id: String
    let threadId: String
    let agentId: String
    let messageId: String
    let prompt: String
    var options: [String]
    var decision: String?
    var decidedAt: Int?
    var createdAt: Int

    var isDecided: Bool { decision != nil }
}

struct Account: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var isOwner: Bool
}

struct Invite: Codable, Identifiable, Hashable {
    var id: String { code }
    let code: String
    var name: String?
    var claimedBy: String?

    var isClaimed: Bool { !(claimedBy ?? "").isEmpty }
}

/// An "agent is working on it" line. Never stored, replaced by the real message.
struct StatusLine: Hashable {
    let agentId: String
    let text: String
}
