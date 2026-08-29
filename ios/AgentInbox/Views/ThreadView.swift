import SwiftUI

struct ThreadView: View {
    @Environment(RelayStore.self) private var store
    let threadId: String

    @State private var confirmingNewSession = false

    private var thread: ChatThread? { store.thread(threadId) }
    private var messages: [Message] { thread?.messages ?? [] }

    var body: some View {
        if thread == nil {
            ContentUnavailableView("Thread removed", systemImage: "tray")
        } else {
            content
        }
    }

    private var content: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                            MessageRow(
                                message: message,
                                showsSender: showsSender(at: index),
                                isGroup: !(thread?.isDM ?? true)
                            )
                            .id(message.id)
                        }
                        if let status = store.statusLines[threadId] {
                            StatusLineView(status: status)
                                .id("status")
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 12)
                }
                .onChange(of: messages.count) { scrollToBottom(proxy) }
                .onChange(of: store.statusLines[threadId]) { scrollToBottom(proxy) }
                .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            }

            Divider()

            Composer(threadId: threadId, participants: store.participants(of: thread ?? emptyThread))
        }
        .background(Color(.systemBackground))
        .navigationTitle(thread.map(store.title(for:)) ?? "Thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        confirmingNewSession = true
                    } label: {
                        Label("Start new session", systemImage: "arrow.counterclockwise")
                    }
                    if let agentId = thread?.agentIds.first {
                        NavigationLink(value: Route.agent(agentId)) {
                            Label("Details", systemImage: "info.circle")
                        }
                    }
                } label: {
                    if let agentId = thread?.agentIds.first {
                        AvatarView(
                            emoji: store.agent(agentId)?.avatarEmoji ?? "🤖",
                            online: store.agent(agentId)?.isOnline ?? false,
                            size: 30
                        )
                    } else {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        .confirmationDialog(
            "Start a new session with \(thread.map(store.title(for:)) ?? "this bot")?",
            isPresented: $confirmingNewSession,
            titleVisibility: .visible
        ) {
            Button("Start new session") { store.startNewSession(in: threadId) }
        } message: {
            Text("The current conversation is cleared. Its long-term memory is kept.")
        }
    }

    private var emptyThread: ChatThread {
        ChatThread(id: threadId, kind: "dm", name: nil, participantIds: [], createdAt: 0, messages: [])
    }

    private func showsSender(at index: Int) -> Bool {
        let message = messages[index]
        if message.isFromUser { return false }
        guard index > 0 else { return true }
        return messages[index - 1].senderId != message.senderId
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }
}

struct StatusLineView: View {
    @Environment(RelayStore.self) private var store
    let status: StatusLine

    var body: some View {
        HStack(spacing: 6) {
            Text(store.agent(status.agentId)?.avatarEmoji ?? "🤖")
            Text(status.text)
                .italic()
                .foregroundStyle(.secondary)
        }
        .font(.footnote)
        .padding(.leading, 4)
        .padding(.top, 4)
        .transition(.opacity)
    }
}
