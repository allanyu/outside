import SwiftUI

struct InboxView: View {
    @Environment(RelayStore.self) private var store
    @State private var path: [Route] = []
    @State private var showingSettings = false
    @State private var showingInvite = false

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if store.threads.isEmpty {
                    ContentUnavailableView(
                        "No chats yet",
                        systemImage: "tray",
                        description: Text("Your chats mirror the bots on your Hermes. Start its gateway and they appear here.")
                    )
                    .listRowSeparator(.hidden)
                }
                ForEach(store.sortedThreads) { thread in
                    NavigationLink(value: Route.thread(thread.id)) {
                        ThreadRow(thread: thread)
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle("Inbox")
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .thread(let id): ThreadView(threadId: id)
                case .agent(let id): AgentDetailView(agentId: id)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showingSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                }
                ToolbarItem(placement: .principal) { ConnectionRow() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingInvite = true
                    } label: {
                        Image(systemName: "person.crop.circle.badge.plus")
                    }
                }
            }
            // Removing an agent deletes its detail screen and its DM out from
            // under whatever is pushed, so pop back to the last screen that
            // still exists instead of leaving an empty one on top.
            .onChange(of: store.agents.count) { prunePath() }
            .onChange(of: store.threads.count) { prunePath() }
            .sheet(isPresented: $showingSettings) { SetupView() }

            .sheet(isPresented: $showingInvite) { InviteView() }
        }
    }

    private func prunePath() {
        guard let first = path.firstIndex(where: { !exists($0) }) else { return }
        path.removeSubrange(first...)
    }

    private func exists(_ route: Route) -> Bool {
        switch route {
        case .thread(let id): store.thread(id) != nil
        case .agent(let id): store.agent(id) != nil
        }
    }
}

struct ThreadRow: View {
    @Environment(RelayStore.self) private var store
    let thread: ChatThread

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AvatarView(emoji: store.emoji(for: thread), online: store.isOnline(thread))

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(store.title(for: thread))
                        .font(.headline)
                        .lineLimit(1)
                    if !thread.isDM {
                        Image(systemName: "person.2.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let last = store.lastMessage(thread) {
                        Text(last.date, format: relativeFormat(last.date))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(preview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }

    private var preview: String {
        guard let last = store.lastMessage(thread) else { return "No messages yet" }
        let who = last.isFromUser ? "You: " : (thread.isDM ? "" : "\(store.agent(last.senderId)?.name ?? last.senderId): ")
        if last.text.isEmpty && !last.attachments.isEmpty { return "\(who)📎 Attachment" }
        return who + plainText(last.text)
    }

    /// The preview is one plain line, so drop the markdown markers rather than
    /// showing raw `**bold**` in the list.
    private func plainText(_ text: String) -> String {
        guard let attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else { return text }
        return String(attributed.characters)
    }

    private func relativeFormat(_ date: Date) -> Date.FormatStyle {
        Calendar.current.isDateInToday(date)
            ? .dateTime.hour().minute()
            : .dateTime.month(.abbreviated).day()
    }
}

struct AvatarView: View {
    let emoji: String
    var online: Bool = false
    var size: CGFloat = 40

    var body: some View {
        Text(emoji)
            .font(.system(size: size * 0.5))
            .frame(width: size, height: size)
            .background(Color(.secondarySystemBackground), in: .circle)
            .overlay(alignment: .bottomTrailing) {
                if online {
                    Circle()
                        .fill(.green)
                        .frame(width: size * 0.28, height: size * 0.28)
                        .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
                }
            }
    }
}
