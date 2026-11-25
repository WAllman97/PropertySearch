import UIKit
import UniformTypeIdentifiers

// Share → ViewPal from Rightmove, Zoopla, OnTheMarket or Safari.
// Finds the listing link in what was shared and opens the app with it
// (viewpal://add?url=...), where Add Property fills in the details
// (src/lib/sharedLinks.js). If iOS won't let us open the app, the link is
// copied instead, ready for the Paste button in Add Property.
final class ShareViewController: UIViewController {
    private let card = UIView()
    private let titleLabel = UILabel()
    private let detailLabel = UILabel()
    private let doneButton = UIButton(type: .system)
    private var handled = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.25)

        card.backgroundColor = .systemBackground
        card.layer.cornerRadius = 16
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)

        titleLabel.font = .preferredFont(forTextStyle: .headline)
        titleLabel.textAlignment = .center
        titleLabel.numberOfLines = 0
        titleLabel.text = "Opening ViewPal…"

        detailLabel.font = .preferredFont(forTextStyle: .subheadline)
        detailLabel.textColor = .secondaryLabel
        detailLabel.textAlignment = .center
        detailLabel.numberOfLines = 0

        doneButton.setTitle("Done", for: .normal)
        doneButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        doneButton.isHidden = true
        doneButton.addTarget(self, action: #selector(close), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [titleLabel, detailLabel, doneButton])
        stack.axis = .vertical
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)

        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.82),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 22),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -18),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !handled else { return }
        handled = true
        findLink { [weak self] link in
            DispatchQueue.main.async { self?.handle(link) }
        }
    }

    private func handle(_ link: URL?) {
        guard let link = link else {
            show("No property link found", "Share a listing from Rightmove, Zoopla or OnTheMarket.")
            return
        }
        var components = URLComponents()
        components.scheme = "viewpal"
        components.host = "add"
        components.queryItems = [URLQueryItem(name: "url", value: link.absoluteString)]

        if let appURL = components.url, openContainingApp(appURL) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.close() }
        } else {
            UIPasteboard.general.string = link.absoluteString
            show("Link copied", "Open ViewPal, tap + Add Property, then Paste.")
        }
    }

    private func show(_ title: String, _ detail: String) {
        titleLabel.text = title
        detailLabel.text = detail
        doneButton.isHidden = false
    }

    @objc private func close() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    // The first web link in the shared items: a URL, or text containing one
    // ("Check out this property on Rightmove! https://...").
    private func findLink(_ done: @escaping (URL?) -> Void) {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
        let sharedText = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .compactMap { $0.attributedContentText?.string }
            .joined(separator: " ")

        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) {
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                if let url = item as? URL, Self.isWebLink(url) {
                    done(url)
                } else if let text = item as? String, let url = Self.firstLink(in: text) {
                    done(url)
                } else {
                    done(Self.firstLink(in: sharedText))
                }
            }
            return
        }
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) }) {
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
                let text = (item as? String) ?? (item as? NSAttributedString)?.string ?? ""
                done(Self.firstLink(in: text + " " + sharedText))
            }
            return
        }
        done(Self.firstLink(in: sharedText))
    }

    private static func isWebLink(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        return scheme == "https" || scheme == "http"
    }

    private static func firstLink(in text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        return detector.matches(in: text, options: [], range: range)
            .compactMap { $0.url }
            .first(where: isWebLink)
    }

    // Extensions can't call UIApplication.shared, so walk the responder chain
    // to the application object and ask it to open our own app's link.
    private func openContainingApp(_ url: URL) -> Bool {
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        guard let appClass = NSClassFromString("UIApplication") else { return false }
        var responder: UIResponder? = self
        while let current = responder {
            if current.isKind(of: appClass), current.responds(to: selector), let method = current.method(for: selector) {
                typealias OpenURL = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
                let open = unsafeBitCast(method, to: OpenURL.self)
                open(current, selector, url as NSURL, NSDictionary(), nil)
                return true
            }
            responder = current.next
        }
        return false
    }
}
