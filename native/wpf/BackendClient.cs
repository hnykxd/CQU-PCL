using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace CquPcl.Native {
    sealed class BackendClient : IDisposable {
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
        readonly HttpClient http = new HttpClient(new HttpClientHandler { UseProxy = false });
        readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        readonly TaskCompletionSource<string> ready = new TaskCompletionSource<string>();
        readonly string logPath;
        readonly object logLock = new object();
        readonly SingleInstance instance;
        Process process;
        bool disposed;
        public event Action<LauncherState> StateChanged;
        public event Action FocusRequested;
        public event Action<string> Disconnected;
        public BackendClient(string data, SingleInstance instance) { this.instance = instance; Directory.CreateDirectory(data); logPath = Path.Combine(data, "launcher-diagnostics.log"); http.Timeout = TimeSpan.FromMinutes(5); }
        public async Task Start(string workspace, string data, string host, bool dev) {
            string token;
            using (var rng = RandomNumberGenerator.Create()) { byte[] bytes = new byte[32]; rng.GetBytes(bytes); token = Convert.ToBase64String(bytes); }
            string node = dev ? (Environment.GetEnvironmentVariable("CQU_PCL_NODE") ?? "node.exe") : Path.Combine(workspace, "node.exe");
            var info = new ProcessStartInfo(node, dev ? "native/backend.mjs" : "server/backend.mjs") { WorkingDirectory = workspace, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
            info.EnvironmentVariables["CQU_PCL_NATIVE"] = "1";
            info.EnvironmentVariables["CQU_PCL_API_ONLY"] = "1";
            info.EnvironmentVariables["CQU_PCL_API_TOKEN"] = token;
            info.EnvironmentVariables["CQU_PCL_DATA"] = data;
            info.EnvironmentVariables["CQU_PCL_HOST"] = host;
            info.EnvironmentVariables["CQU_PCL_WAIT_FOR_HOST"] = "1";
            process = new Process { StartInfo = info, EnableRaisingEvents = true };
            process.OutputDataReceived += (sender, e) => {
                if (e.Data == null) return;
                if (e.Data.StartsWith("CQU_READY ")) ready.TrySetResult(e.Data.Substring(10));
                else if (e.Data == "CQU_FOCUS") { var handler = FocusRequested; if (handler != null) handler(); }
                else Log(e.Data);
            };
            process.ErrorDataReceived += (sender, e) => { if (e.Data != null) Log(e.Data); };
            process.Exited += (sender, e) => {
                if (disposed) return;
                string error = "启动器服务已退出，请查看 launcher-diagnostics.log。";
                ready.TrySetException(new Exception(error)); var handler = Disconnected; if (handler != null) handler(error);
            };
            process.Start();
            instance.ProtectBackend(process);
            process.StandardInput.WriteLine("CQU_START"); process.StandardInput.Flush();
            process.BeginOutputReadLine(); process.BeginErrorReadLine();
            if (await Task.WhenAny(ready.Task, Task.Delay(30000, lifetime.Token)) != ready.Task) throw new Exception("启动器服务启动超时，请查看 launcher-diagnostics.log。");
            var origin = new Uri(await ready.Task);
            if (origin.Scheme != "http" || origin.Host != "127.0.0.1") throw new Exception("启动器服务地址无效。");
            http.BaseAddress = origin; http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            ReceiveEvents();
        }
        public async Task<T> Request<T>(string endpoint, object body = null, string method = null) {
            using (var request = new HttpRequestMessage(new HttpMethod(method ?? (body == null ? "GET" : "POST")), "/api" + endpoint)) {
                if (body != null) request.Content = new StringContent(json.Serialize(body), System.Text.Encoding.UTF8, "application/json");
                using (var response = await http.SendAsync(request, lifetime.Token)) {
                    string text = await response.Content.ReadAsStringAsync();
                    if (!response.IsSuccessStatusCode) throw new Exception(json.Deserialize<ApiError>(text).error ?? "请求失败");
                    return json.Deserialize<T>(text);
                }
            }
        }
        public async Task<Pack> InspectPack(string file) {
            if (new FileInfo(file).Length > 512L * 1024 * 1024) throw new Exception("整合包大小超过 512 MB 限制。");
            using (var content = new StreamContent(File.OpenRead(file))) {
                content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                using (var response = await http.PostAsync("/api/packs/inspect", content, lifetime.Token)) {
                    string text = await response.Content.ReadAsStringAsync();
                    if (!response.IsSuccessStatusCode) throw new Exception(json.Deserialize<ApiError>(text).error);
                    return json.Deserialize<Pack>(text);
                }
            }
        }
        public async Task<byte[]> Texture(string kind, string id) { return await http.GetByteArrayAsync("/api/auth/appearance/" + kind + "/" + Uri.EscapeDataString(id)); }
        async void ReceiveEvents() {
            while (!lifetime.IsCancellationRequested) {
                try {
                    using (var response = await http.GetAsync("/api/events", HttpCompletionOption.ResponseHeadersRead, lifetime.Token)) {
                        response.EnsureSuccessStatusCode();
                        using (var stream = await response.Content.ReadAsStreamAsync())
                        using (var registration = lifetime.Token.Register(() => stream.Dispose()))
                        using (var reader = new StreamReader(stream)) {
                            string line;
                            while (!lifetime.IsCancellationRequested && (line = await reader.ReadLineAsync()) != null) {
                                if (line.StartsWith("data: ")) { var state = json.Deserialize<LauncherState>(line.Substring(6)); var handler = StateChanged; if (handler != null) handler(state); }
                            }
                        }
                    }
                } catch (Exception e) { if (!disposed) Log("状态连接：" + e.Message); }
                if (!disposed) { try { await Task.Delay(2000, lifetime.Token); } catch (OperationCanceledException) { return; } }
            }
        }
        void Log(string message) { lock (logLock) { try { File.AppendAllText(logPath, DateTime.Now.ToString("s") + " " + message + Environment.NewLine); } catch {} } }
        public void Dispose() {
            if (disposed) return; disposed = true; lifetime.Cancel(); http.Dispose();
            if (process != null) { try { if (!process.HasExited) { process.StandardInput.Close(); if (!process.WaitForExit(1500)) process.Kill(); } } catch {} process.Dispose(); }
        }
    }
}
