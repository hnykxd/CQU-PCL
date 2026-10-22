using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CquPcl.Native {
    // The file handle is the authority: Windows also enforces it through case
    // aliases, junctions and other sessions. Keep the file after release so a
    // competing process can never open a newly recreated, unlocked file.
    sealed class SingleInstance : IDisposable {
        const string EventPrefix = "Local\\CQU-PCL-Activate-";
        readonly FileStream ownership;
        readonly EventWaitHandle activation;
        RegisteredWaitHandle listener;
        bool disposed;

        [DllImport("user32.dll")]
        static extern bool AllowSetForegroundWindow(int processId);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr duplicate, uint access, bool inherit, uint options);

        SingleInstance(FileStream ownership, EventWaitHandle activation) {
            this.ownership = ownership; this.activation = activation;
        }

        public static SingleInstance Acquire(string dataDirectory) {
            Directory.CreateDirectory(dataDirectory);
            string lockPath = Path.Combine(dataDirectory, ".launcher-instance.lock");
            var retry = Stopwatch.StartNew();
            while (true) {
                FileStream file;
                try { file = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read); }
                catch (IOException error) {
                    int code = Marshal.GetHRForException(error) & 0xffff;
                    if (code != 32 && code != 33) throw;
                    if (ActivateOwner(lockPath)) return null;
                    if (retry.ElapsedMilliseconds >= 5000) throw new Exception("此数据目录的启动器正在启动或退出，请稍后重试。");
                    Thread.Sleep(50); continue;
                }
                EventWaitHandle signal = null;
                try {
                    string eventName = EventPrefix + Guid.NewGuid().ToString("N");
                    signal = new EventWaitHandle(false, EventResetMode.AutoReset, eventName);
                    using (var process = Process.GetCurrentProcess()) {
                        string owner = process.Id + "\n" + process.StartTime.ToUniversalTime().Ticks + "\n" + eventName;
                        byte[] bytes = Encoding.UTF8.GetBytes(owner);
                        file.SetLength(0); file.Write(bytes, 0, bytes.Length); file.Flush(true);
                    }
                    return new SingleInstance(file, signal);
                } catch { if (signal != null) signal.Dispose(); file.Dispose(); throw; }
            }
        }

        static bool ActivateOwner(string lockPath) {
            try {
                string owner;
                using (var file = new FileStream(lockPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
                    if (file.Length == 0 || file.Length > 512) return false;
                    using (var reader = new StreamReader(file, Encoding.UTF8)) owner = reader.ReadToEnd();
                }
                string[] parts = owner.Split('\n'); int pid; long start;
                if (parts.Length != 3 || !Int32.TryParse(parts[0], out pid) || !Int64.TryParse(parts[1], out start) || !parts[2].StartsWith(EventPrefix, StringComparison.Ordinal)) return false;
                using (var process = Process.GetProcessById(pid)) {
                    if (process.HasExited || process.StartTime.ToUniversalTime().Ticks != start) return false;
                    using (var signal = EventWaitHandle.OpenExisting(parts[2])) {
                        // The user's second launch can grant the existing process
                        // foreground permission without forcing an always-on-top window.
                        AllowSetForegroundWindow(pid); signal.Set(); return true;
                    }
                }
            } catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
            catch (WaitHandleCannotBeOpenedException) { return false; }
            catch (ArgumentException) { return false; }
            catch (InvalidOperationException) { return false; }
            catch (System.ComponentModel.Win32Exception) { return false; }
        }

        public void Attach(LauncherWindow window) {
            // An AutoReset event remembers launches that happen before WPF is ready.
            listener = ThreadPool.RegisterWaitForSingleObject(activation, (state, timedOut) => window.RequestActivation(), null, Timeout.Infinite, false);
        }

        public void ProtectBackend(Process backend) {
            // The Node process owns the duplicate until it exits. Even a killed
            // WPF host cannot release the directory while Node is still writing.
            // The non-inheritable handle is not passed on to Minecraft/crypto helpers.
            using (var current = Process.GetCurrentProcess()) {
                IntPtr duplicate;
                if (!DuplicateHandle(current.Handle, ownership.SafeFileHandle.DangerousGetHandle(), backend.Handle, out duplicate, 0, false, 2)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
        }

        public void Dispose() {
            if (disposed) return; disposed = true;
            if (listener != null) listener.Unregister(null);
            activation.Dispose(); ownership.Dispose();
        }
    }
}
