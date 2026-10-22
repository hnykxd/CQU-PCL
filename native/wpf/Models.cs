using System;
using System.Collections.Generic;

namespace CquPcl.Native {
    public class LauncherState {
        public List<Instance> instances { get; set; }
        public string selectedId { get; set; }
        public List<Job> jobs { get; set; }
        public string root { get; set; }
        public Settings settings { get; set; }
        public LoginConfiguration microsoftLogin { get; set; }
        public Account account { get; set; }
    }
    public class LoginConfiguration { public bool configured { get; set; } }
    public class Settings {
        public string source { get; set; }
        public int memory { get; set; }
        public string javaPath { get; set; }
        public string playerName { get; set; }
        public string loginMode { get; set; }
        public string curseforgeKey { get; set; }
        public int concurrency { get; set; }
    }
    public class Instance {
        public string id { get; set; }
        public string name { get; set; }
        public string minecraft { get; set; }
        public string loader { get; set; }
        public string loaderVersion { get; set; }
        public string edition { get; set; }
        public string status { get; set; }
        public bool running { get; set; }
        public string directory { get; set; }
        public string error { get; set; }
        public string lastPlayed { get; set; }
        public List<Mod> mods { get; set; }
        public Pack pack { get; set; }
        public string Summary { get { return (edition == "bedrock-server" ? "基岩服务端 " : "Minecraft ") + minecraft + " · " + Labels.Loader(loader) + (String.IsNullOrEmpty(loaderVersion) ? "" : " " + loaderVersion); } }
        public override string ToString() { return name + " · " + minecraft; }
    }
    public class Job {
        public string id { get; set; }
        public string title { get; set; }
        public string instanceId { get; set; }
        public string status { get; set; }
        public double progress { get; set; }
        public string stage { get; set; }
        public string error { get; set; }
        public string currentFile { get; set; }
        public List<DownloadFile> activeFiles { get; set; }
        public double downloadedBytes { get; set; }
        public double speedBytesPerSecond { get; set; }
        public int connections { get; set; }
    }
    public class DownloadFile {
        public string fileName { get; set; }
        public double receivedBytes { get; set; }
        public double totalBytes { get; set; }
        public int connections { get; set; }
    }
    public class Mod {
        public string fileName { get; set; }
        public string name { get; set; }
        public string versionNumber { get; set; }
        public string latestId { get; set; }
        public string latestVersion { get; set; }
        public string source { get; set; }
        public bool? enabled { get; set; }
        public bool? recognized { get; set; }
        public string warning { get; set; }
    }
    public class Pack {
        public string token { get; set; }
        public string name { get; set; }
        public string version { get; set; }
        public string minecraft { get; set; }
        public string loader { get; set; }
        public string loaderVersion { get; set; }
        public int fileCount { get; set; }
        public string format { get; set; }
        public string projectId { get; set; }
    }
    public class Account {
        public string name { get; set; }
        public string uuid { get; set; }
        public long expiresAt { get; set; }
        public List<Texture> skins { get; set; }
        public List<Texture> capes { get; set; }
    }
    public class Texture {
        public string id { get; set; }
        public string name { get; set; }
        public string variant { get; set; }
        public bool active { get; set; }
        public string url { get; set; }
    }
    public class LoginFlow {
        public string flowId { get; set; }
        public string userCode { get; set; }
        public string verificationUri { get; set; }
        public double interval { get; set; }
        public int expiresIn { get; set; }
    }
    public class LoginPoll { public bool pending { get; set; } public double interval { get; set; } }
    public class GameVersion {
        public string id { get; set; }
        public string type { get; set; }
        public override string ToString() { return id + (type == "release" ? "" : " · " + type); }
    }
    public class GameManifest { public List<GameVersion> versions { get; set; } }
    public class LoaderManifest { public List<string> versions { get; set; } }
    public class Project {
        public string project_id { get; set; }
        public string title { get; set; }
        public string description { get; set; }
        public string author { get; set; }
        public long downloads { get; set; }
        public string project_type { get; set; }
    }
    public class SearchResult { public List<Project> hits { get; set; } }
    public class ProjectVersion {
        public string id { get; set; }
        public string version_number { get; set; }
        public string version_type { get; set; }
        public string[] game_versions { get; set; }
        public string[] loaders { get; set; }
        public override string ToString() { return version_number + " · " + String.Join(", ", game_versions ?? new string[0]) + (version_type == "release" ? "" : " · " + version_type); }
    }
    public class ProjectManifest { public List<ProjectVersion> versions { get; set; } }
    public class Updates { public List<Mod> mods { get; set; } public ProjectVersion pack { get; set; } }
    public class BedrockVersion {
        public string platform { get; set; }
        public string version { get; set; }
        public string url { get; set; }
        public override string ToString() { return version + " · " + platform; }
    }
    public class BedrockManifest { public List<BedrockVersion> versions { get; set; } }
    public class LogResult { public string text { get; set; } }
    public class ApiError { public string error { get; set; } }
    public static class Labels {
        public static string Loader(string value) { switch(value) { case "vanilla": return "原版"; case "fabric": return "Fabric"; case "quilt": return "Quilt"; case "forge": return "Forge"; case "neoforge": return "NeoForge"; default: return value; } }
        public static string Status(string value) { switch(value) { case "ready": return "已就绪"; case "installing": return "安装中"; case "running": return "进行中"; case "queued": return "等待中"; case "complete": return "已完成"; case "cancelled": return "已取消"; case "error": return "未完成"; default: return value; } }
    }
}
