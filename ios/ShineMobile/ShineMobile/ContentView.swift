import SwiftUI

struct ContentView: View {
    private let shineURL = URL(string: "https://shineaimobile.pages.dev/")!

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            WebView(url: shineURL)
                .ignoresSafeArea(.keyboard, edges: .bottom)
        }
    }
}

#Preview {
    ContentView()
}