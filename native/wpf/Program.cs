using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows;

namespace CquPcl.Native {
    static class Program {
        [STAThread]
        static int Main(string[] args) {
            if (args.Length == 2 && args[0] == "--crypto") {
                try {
                    string input = Console.In.ReadToEnd();
                    if (args[1] == "encrypt") Console.Out.Write(Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(input), null, DataProtectionScope.CurrentUser)));
                    else if (args[1] == "decrypt") Console.Out.Write(Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(input), null, DataProtectionScope.CurrentUser)));
                    else return 1;
                    return 0;
                } catch { return 1; }
            }
            try {
                string exe = Process.GetCurrentProcess().MainModule.FileName;
                bool dev = args.Length >= 2 && args[0] == "--workspace";
                string workspace = dev ? Path.GetFullPath(args[1]) : null;
                string data = Path.GetFullPath(Environment.GetEnvironmentVariable("CQU_PCL_DATA_OVERRIDE") ?? (dev ? Path.Combine(workspace, ".cqu-pcl") : Path.Combine(Path.GetDirectoryName(exe), "CQU-PCL-Data")));
                // Acquire before extraction, WPF construction or any backend/config writes.
                // --crypto deliberately bypasses this guard for the running backend.
                using (var instance = SingleInstance.Acquire(data)) {
                    if (instance == null) return 0;
                    if (!dev) workspace = Unpack();
                    var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
                    app.DispatcherUnhandledException += (sender, e) => { MessageBox.Show(e.Exception.Message, "CQU PCL"); e.Handled = true; };
                    var window = new LauncherWindow(workspace, data, exe, dev, instance);
                    instance.Attach(window);
                    if (Array.IndexOf(args, "--smoke-test") >= 0) window.EnableSmokeTest();
                    return app.Run(window);
                }
            } catch (Exception e) {
                string diagnostics = Environment.GetEnvironmentVariable("CQU_PCL_DATA_OVERRIDE");
                if (!String.IsNullOrEmpty(diagnostics)) { Directory.CreateDirectory(diagnostics); File.WriteAllText(Path.Combine(diagnostics, "startup-error.log"), e.ToString()); }
                if (Array.IndexOf(args, "--smoke-test") < 0) MessageBox.Show(e.Message, "CQU PCL", MessageBoxButton.OK, MessageBoxImage.Error);
                return 1;
            }
        }
        static string Unpack() {
            string hash;
            using (var input = typeof(Program).Assembly.GetManifestResourceStream("payload.zip")) {
                if (input == null) throw new Exception("程序包不完整，请使用 npm run dist 构建原生启动器。");
                using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").Substring(0, 20);
            }
            string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CQU-PCL", "runtime", hash);
            using (var mutex = new Mutex(false, "Local\\CQU-PCL-Extract-" + hash)) {
                bool acquired = false;
                try {
                    try { acquired = mutex.WaitOne(60000); } catch (AbandonedMutexException) { acquired = true; }
                    if (!acquired) throw new Exception("启动器解包超时，请稍后重试。");
                    Directory.CreateDirectory(root);
                    if (!File.Exists(Path.Combine(root, ".ready"))) {
                        using (var input = typeof(Program).Assembly.GetManifestResourceStream("payload.zip"))
                        using (var zip = new ZipArchive(input, ZipArchiveMode.Read)) {
                            foreach (var entry in zip.Entries) {
                                string destination = Path.GetFullPath(Path.Combine(root, entry.FullName));
                                if (!destination.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("程序包路径无效。");
                                if (entry.FullName.EndsWith("/")) continue;
                                Directory.CreateDirectory(Path.GetDirectoryName(destination)); entry.ExtractToFile(destination, true);
                            }
                        }
                        File.WriteAllText(Path.Combine(root, ".ready"), hash);
                    }
                } finally { if (acquired) mutex.ReleaseMutex(); }
            }
            return root;
        }
    }
}
