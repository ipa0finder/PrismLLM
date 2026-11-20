import SwiftUI
import WebKit

struct ContentView: View {
    var body: some View {
        PrismWebView()
            .ignoresSafeArea()
            .background(Color(red: 0.035, green: 0.035, blue: 0.05))
    }
}

struct PrismWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "prism")
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.035, green: 0.035, blue: 0.05, alpha: 1)
        web.scrollView.keyboardDismissMode = .interactive
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = context.coordinator
        context.coordinator.webView = web
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "www") {
            web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else if let url = Bundle.main.url(forResource: "index", withExtension: "html") {
            web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, URLSessionDataDelegate {
        weak var webView: WKWebView?
        private var tasks: [String: URLSessionDataTask] = [:]
        private var buffers: [String: Data] = [:]
        private var sessions: [String: URLSession] = [:]

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "haptic":
                DispatchQueue.main.async { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
            case "keychainSet":
                guard let key = body["key"] as? String, let value = body["value"] as? String else { return }
                let ok = KeychainStore.set(value, for: key)
                callback(body["callback"] as? String, ["ok": ok])
            case "keychainGet":
                let key = body["key"] as? String ?? ""
                callback(body["callback"] as? String, ["value": KeychainStore.get(key) ?? ""])
            case "cancel":
                if let id = body["id"] as? String { tasks[id]?.cancel(); tasks[id] = nil }
            case "request":
                startRequest(body)
            default: break
            }
        }

        private func startRequest(_ body: [String: Any]) {
            guard let id = body["id"] as? String, let rawURL = body["url"] as? String,
                  let url = URL(string: rawURL), ["https", "http"].contains(url.scheme?.lowercased() ?? "") else {
                callback(body["id"] as? String, ["error": "Invalid request URL"]); return
            }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 120
            if let headers = body["headers"] as? [String: String] { headers.forEach { request.setValue($1, forHTTPHeaderField: $0) } }
            if let payload = body["body"], let data = try? JSONSerialization.data(withJSONObject: payload) { request.httpBody = data }
            buffers[id] = Data()
            let session = URLSession(configuration: .default, delegate: self, delegateQueue: OperationQueue.main)
            sessions[id] = session
            let task = session.dataTask(with: request)
            tasks[id] = task
            task.resume()
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            guard let id = tasks.first(where: { $0.value === dataTask })?.key else { return }
            buffers[id, default: Data()].append(data)
            // Stream OpenAI SSE deltas to the page as they arrive.
            if let text = String(data: data, encoding: .utf8), text.contains("data:") {
                for line in text.components(separatedBy: .newlines) where line.hasPrefix("data:") {
                    let raw = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                    if raw == "[DONE]" { continue }
                    if let json = raw.data(using: .utf8),
                       let object = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
                       let choices = object["choices"] as? [[String: Any]],
                       let delta = choices.first?["delta"] as? [String: Any],
                       let token = delta["content"] as? String {
                        callback(id, ["chunk": token])
                    }
                }
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            guard let id = tasks.first(where: { $0.value === task })?.key else { return }
            defer { tasks[id] = nil; buffers[id] = nil; sessions[id]?.invalidateAndCancel(); sessions[id] = nil }
            if let error { callback(id, ["error": error.localizedDescription]); return }
            let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200...299).contains(status) else {
                let body = String(data: buffers[id] ?? Data(), encoding: .utf8) ?? ""
                callback(id, ["error": "HTTP \(status): \(body.prefix(400))"]); return
            }
            let raw = buffers[id] ?? Data()
            let json = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] ?? [:]
            callback(id, ["done": true, "json": json])
        }

        private func callback(_ name: String?, _ value: [String: Any]) {
            guard let name, let data = try? JSONSerialization.data(withJSONObject: value),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView?.evaluateJavaScript("window[\(name)] && window[\(name)](\(json));", completionHandler: nil)
        }
    }
}
