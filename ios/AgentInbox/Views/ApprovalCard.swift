import SwiftUI

struct ApprovalCard: View {
    @Environment(RelayStore.self) private var store
    let approval: Approval

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Needs a decision", systemImage: "hand.raised.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            Text(approval.prompt)
                .font(.callout)

            HStack(spacing: 8) {
                ForEach(approval.options, id: \.self) { option in
                    Button {
                        store.decide(approvalId: approval.id, decision: option)
                    } label: {
                        Text(option)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(approval.decision == option ? Color.accentColor : Color.gray.opacity(0.35))
                    .foregroundStyle(approval.decision == option ? Color.white : Color.primary)
                }
            }
            .disabled(approval.isDecided)

            if let decision = approval.decision {
                Text("You chose \(decision)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: 300, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .stroke(Color.accentColor.opacity(approval.isDecided ? 0 : 0.4), lineWidth: 1)
        )
    }
}
