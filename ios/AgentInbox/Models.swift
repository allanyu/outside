import Foundation

/// The user is a participant in every thread and always has this id.
let userID = "user"

struct Agent: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var avatarEmoji: String
    var status: String
    var lastSeen: Int

    var isOnline: Bool { status == "online" }
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

/// An "agent is working on it" line. Never stored, replaced by the real message.
struct StatusLine: Hashable {
    let agentId: String
    let text: String
}
