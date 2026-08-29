import Foundation
import Observation

/// Everything the app knows. It holds no agent logic: it sends what the user
/// typed to the relay and renders whatever comes back.
@MainActor
@Observable
final class RelayStore {

    enum Connection: Equatable {
        case idle, connecting, connected
        case failed(String)

        var isConnected: Bool { self == .connected }
    }

    // MARK: stored settings

    private enum Keys {
        static let url = "relayURL"
        static let token = "relayToken"
    }

    var relayURL: String = UserDefaults.standard.string(forKey: Keys.url) ?? ""
    var token: String = UserDefaults.standard.string(forKey: Keys.token) ?? ""
    var isConfigured: Bool { !relayURL.isEmpty && !token.isEmpty }

    // MARK: live state

    var connection: Connection = .idle
    var agents: [Agent] = []
    var threads: [ChatThread] = []
    var approvals: [Approval] = []
    var statusLines: [String: StatusLine] = [:]     // threadId -> ephemeral line
    var lastError: String?

    private var task: URLSessionWebSocketTask?
    private var readTask: Task<Void, Never>?
    private var reconnectAttempt = 0
    private let session = URLSession(configuration: .default)

    // MARK: - lifecycle

    func save(relayURL: String, token: String) {
        self.relayURL = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(self.relayURL, forKey: Keys.url)
        UserDefaults.standard.set(self.token, forKey: Keys.token)
    }

    func signOut() {
        disconnect()
        save(relayURL: "", token: "")
        agents = []
        threads = []
        approvals = []
        statusLines = [:]
        connection = .idle
    }

    /// agentinbox://connect?url=http://10.0.0.2:8787&token=dev-token
    func handle(url: URL) {
        guard url.scheme == "agentinbox", url.host == "connect",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return }
        let relay = items.first { $0.name == "url" }?.value ?? ""
        let tok = items.first { $0.name == "token" }?.value ?? ""
        guard !relay.isEmpty, !tok.isEmpty else { return }
        save(relayURL: relay, token: tok)
        connect()
    }

    var baseURL: URL? { URL(string: relayURL) }

    private var socketURL: URL? {
        guard var comps = URLComponents(string: relayURL) else { return nil }
        comps.scheme = comps.scheme == "https" ? "wss" : "ws"
        comps.path = "/ws/app"
        comps.queryItems = [URLQueryItem(name: "token", value: token)]
        return comps.url
    }

    func connect() {
        guard isConfigured, let url = socketURL else { return }
        disconnect()
        connection = .connecting
        lastError = nil

        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()

        readTask = Task { [weak self] in
            await self?.readLoop(task)
        }
    }

    func disconnect() {
        readTask?.cancel()
        readTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func readLoop(_ task: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let frame = try await task.receive()
                if connection != .connected {
                    connection = .connected
                    reconnectAttempt = 0
                }
                switch frame {
                case .string(let s): handle(data: Data(s.utf8))
                case .data(let d): handle(data: d)
                @unknown default: break
                }
            } catch {
                guard !Task.isCancelled else { return }
                connection = .failed(error.localizedDescription)
                scheduleReconnect()
                return
            }
        }
    }

    private func scheduleReconnect() {
        reconnectAttempt += 1
        let delay = min(pow(2.0, Double(reconnectAttempt)) * 0.5, 10)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            self.connect()
        }
    }

    // MARK: - inbound events

    private struct Envelope: Decodable { let type: String }

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) -> T? {
        do { return try Self.decoder.decode(type, from: data) }
        catch {
            lastError = "decode \(T.self): \(error)"
            return nil
        }
    }

    private struct SnapshotEvent: Decodable {
        let agents: [Agent]
        let threads: [ChatThread]
        let approvals: [Approval]
    }
    private struct MessageEvent: Decodable { let message: Message }
    private struct StatusEvent: Decodable {
        let threadId: String, agentId: String, text: String
    }
    private struct StreamEvent: Decodable {
        let threadId: String, messageId: String, delta: String
    }
    private struct AgentStatusEvent: Decodable { let agent: Agent }
    private struct ThreadEvent: Decodable { let thread: ChatThread }
    private struct ApprovalEvent: Decodable { let approval: Approval }
    private struct ErrorEvent: Decodable { let error: String }

    private func handle(data: Data) {
        guard let envelope = try? Self.decoder.decode(Envelope.self, from: data) else { return }
        switch envelope.type {
        case "snapshot":
            guard let e = decode(SnapshotEvent.self, data) else { return }
            agents = e.agents
            threads = e.threads
            approvals = e.approvals
            statusLines = [:]

        case "message":
            guard let e = decode(MessageEvent.self, data) else { return }
            upsert(e.message)
            statusLines[e.message.threadId] = nil

        case "stream":
            guard let e = decode(StreamEvent.self, data) else { return }
            appendDelta(e.delta, to: e.messageId, in: e.threadId)

        case "stream_end":
            guard let e = decode(MessageEvent.self, data) else { return }
            upsert(e.message)
            statusLines[e.message.threadId] = nil

        case "status":
            guard let e = decode(StatusEvent.self, data) else { return }
            statusLines[e.threadId] = StatusLine(agentId: e.agentId, text: e.text)

        case "agent_status":
            guard let e = decode(AgentStatusEvent.self, data) else { return }
            if let i = agents.firstIndex(where: { $0.id == e.agent.id }) {
                agents[i] = e.agent
            } else {
                agents.append(e.agent)
            }

        case "thread":
            guard let e = decode(ThreadEvent.self, data) else { return }
            if let i = threads.firstIndex(where: { $0.id == e.thread.id }) {
                var t = e.thread
                if t.messages == nil { t.messages = threads[i].messages }
                threads[i] = t
            } else {
                threads.append(e.thread)
            }

        case "approval":
            guard let e = decode(ApprovalEvent.self, data) else { return }
            if let i = approvals.firstIndex(where: { $0.id == e.approval.id }) {
                approvals[i] = e.approval
            } else {
                approvals.append(e.approval)
            }

        case "error":
            lastError = decode(ErrorEvent.self, data)?.error

        default:
            break
        }
    }

    private func upsert(_ message: Message) {
        guard let ti = threads.firstIndex(where: { $0.id == message.threadId }) else { return }
        var messages = threads[ti].messages ?? []
        if let mi = messages.firstIndex(where: { $0.id == message.id }) {
            messages[mi] = message
        } else {
            messages.append(message)
            messages.sort { $0.createdAt < $1.createdAt }
        }
        threads[ti].messages = messages
    }

    private func appendDelta(_ delta: String, to messageId: String, in threadId: String) {
        guard let ti = threads.firstIndex(where: { $0.id == threadId }),
              var messages = threads[ti].messages,
              let mi = messages.firstIndex(where: { $0.id == messageId })
        else { return }
        messages[mi].text += delta
        threads[ti].messages = messages
        statusLines[threadId] = nil
    }

    // MARK: - outbound

    private func send(_ payload: [String: Any]) {
        guard let task,
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8)
        else { return }
        task.send(.string(text)) { [weak self] error in
            guard let error else { return }
            Task { @MainActor in self?.lastError = error.localizedDescription }
        }
    }

    func send(text: String, in threadId: String, attachments: [Attachment] = []) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        var payload: [String: Any] = ["type": "send", "thread_id": threadId, "text": trimmed]
        if !attachments.isEmpty {
            payload["attachments"] = attachments.map {
                ["id": $0.id, "url": $0.url, "mime": $0.mime]
            }
        }
        send(payload)
    }

    func createThread(kind: String, name: String?, participantIds: [String]) {
        var payload: [String: Any] = [
            "type": "create_thread",
            "kind": kind,
            "participant_ids": participantIds,
        ]
        if let name, !name.isEmpty { payload["name"] = name }
        send(payload)
    }

    func decide(approvalId: String, decision: String) {
        send(["type": "decide", "approval_id": approvalId, "decision": decision])
    }

    /// Uploads bytes and returns the attachment to put on the next message.
    func upload(_ data: Data, mime: String) async throws -> Attachment {
        guard var comps = URLComponents(string: relayURL) else {
            throw URLError(.badURL)
        }
        comps.path = "/api/files"
        comps.queryItems = [URLQueryItem(name: "mime", value: mime)]
        guard let url = comps.url else { throw URLError(.badURL) }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let (body, response) = try await session.upload(for: request, from: data)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try Self.decoder.decode(Attachment.self, from: body)
    }

    // MARK: - lookups

    func agent(_ id: String) -> Agent? { agents.first { $0.id == id } }

    func thread(_ id: String) -> ChatThread? { threads.first { $0.id == id } }

    func approval(forMessage messageId: String) -> Approval? {
        approvals.first { $0.messageId == messageId }
    }

    func threads(containing agentId: String) -> [ChatThread] {
        threads.filter { $0.participantIds.contains(agentId) }
    }

    func fileURL(_ attachment: Attachment) -> URL? {
        guard let base = baseURL else { return nil }
        return URL(string: attachment.url, relativeTo: base)
    }

    func title(for thread: ChatThread) -> String {
        if thread.isDM {
            return thread.agentIds.first.flatMap { agent($0)?.name } ?? thread.name ?? "DM"
        }
        if let name = thread.name, !name.isEmpty { return name }
        let names = thread.agentIds.compactMap { agent($0)?.name }
        return names.isEmpty ? "Group" : names.joined(separator: ", ")
    }

    func emoji(for thread: ChatThread) -> String {
        if thread.isDM {
            return thread.agentIds.first.flatMap { agent($0)?.avatarEmoji } ?? "💬"
        }
        return "👥"
    }

    func isOnline(_ thread: ChatThread) -> Bool {
        thread.agentIds.contains { agent($0)?.isOnline == true }
    }

    func lastMessage(_ thread: ChatThread) -> Message? { thread.messages?.last }

    /// Newest conversation first.
    var sortedThreads: [ChatThread] {
        threads.sorted { a, b in
            (lastMessage(a)?.createdAt ?? a.createdAt) > (lastMessage(b)?.createdAt ?? b.createdAt)
        }
    }

    func participants(of thread: ChatThread) -> [Agent] {
        thread.agentIds.compactMap { agent($0) }
    }
}
