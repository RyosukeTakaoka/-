// swift-tools-version:5.9
// OniGameCore: ゲームのルール（純粋なロジック）。画面・地図・Supabase に依存しないので、Mac でも Linux でもテストできる。
// oni-game/js/game（Web 版・Cloud Functions と共通のルール）を Swift に移植したもの。
import PackageDescription

let package = Package(
    name: "OniGameCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "OniGameCore", targets: ["OniGameCore"]),
    ],
    targets: [
        .target(name: "OniGameCore"),
        .testTarget(
            name: "OniGameCoreTests",
            dependencies: ["OniGameCore"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
