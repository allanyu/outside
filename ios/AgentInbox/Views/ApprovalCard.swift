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
                            .font(.subheadline.weight(.medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 9)
                            .background(background(for: option), in: .capsule)
                            .foregroundStyle(foreground(for: option))
                    }
                    .buttonStyle(.plain)
                }
            }
            // allowsHitTesting rather than disabled: disabled dims the chosen
            // option too, which made the decision harder to read than the
            // option that was not taken.
            .allowsHitTesting(!approval.isDecided)

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

    private func isChosen(_ option: String) -> Bool { approval.decision == option }

    private func background(for option: String) -> AnyShapeStyle {
        if isChosen(option) { return AnyShapeStyle(Color.accentColor) }
        if approval.isDecided { return AnyShapeStyle(Color(.tertiarySystemFill)) }
        return AnyShapeStyle(Color.accentColor.opacity(0.15))
    }

    private func foreground(for option: String) -> AnyShapeStyle {
        if isChosen(option) { return AnyShapeStyle(Color.white) }
        if approval.isDecided { return AnyShapeStyle(Color.secondary) }
        return AnyShapeStyle(Color.accentColor)
    }
}
