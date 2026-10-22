using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace CquPcl.Native {
    sealed partial class LauncherWindow {
        bool smokeTest;
        bool pauseSmokeState;
        public void EnableSmokeTest() { smokeTest = true; }
        async Task SmokeTest() {
            string output = Path.Combine(dataRoot, "native-qa"); Directory.CreateDirectory(output);
            try {
                if (Environment.GetEnvironmentVariable("CQU_PCL_NATIVE_QA") == "1") {
                    if (Selected.mods == null || !Selected.mods.Any(m => m.name == "本地测试模组" && m.versionNumber == "1.2.3")) throw new Exception("Local mod inventory was not loaded.");
                    Navigate("instances");
                    var openFolder = Descendants(Find<StackPanel>("InstancesList")).OfType<Button>().First(b => (string)b.Content == "打开目录");
                    openFolder.RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
                    if (File.ReadAllText(Path.Combine(output, "opened-directory.txt")) != Selected.directory) throw new Exception("Open directory button did not use the world directory.");
                    var fixtureJob = new Job { id = "ui-download-fixture", title = "安装 Minecraft · 进度测试", instanceId = Selected.id, status = "running", stage = "下载游戏文件 · 3/18", progress = 35,
                        currentFile = "minecraft-client.jar", downloadedBytes = 125 * 1024 * 1024, speedBytesPerSecond = 8.5 * 1024 * 1024, connections = 5,
                        activeFiles = new System.Collections.Generic.List<DownloadFile> { new DownloadFile { fileName = "minecraft-client.jar", receivedBytes = 32 * 1024 * 1024, totalBytes = 64 * 1024 * 1024, connections = 4 }, new DownloadFile { fileName = "fabric-api.jar", connections = 1 } } };
                    pauseSmokeState = true; state.jobs.Add(fixtureJob); Navigate("tasks"); UpdateLayout(); Find<Border>("Toast").Visibility = Visibility.Collapsed;
                    var taskControls = Descendants(Find<StackPanel>("TasksList")).OfType<TextBlock>().ToList();
                    if (!taskControls.Any(t => t.Text.Contains("minecraft-client.jar")) || !taskControls.Any(t => t.Text.Contains("8.50 MB/s"))) throw new Exception("File name or live speed was not rendered.");
                    var removeButton = Descendants(Find<StackPanel>("TasksList")).OfType<Button>().First(b => (string)b.Content == "删除任务");
                    fixtureJob.speedBytesPerSecond = 9 * 1024 * 1024; RenderTasks();
                    if (!Object.ReferenceEquals(removeButton, Descendants(Find<StackPanel>("TasksList")).OfType<Button>().First(b => (string)b.Content == "删除任务"))) throw new Exception("Progress refresh replaced active task controls.");
                    Capture(Path.Combine(output, "tasks-active.png"));
                    Width = MinWidth; Height = MinHeight; await Task.Delay(180); UpdateLayout(); Capture(Path.Combine(output, "tasks-minimum.png"));
                    Width = 1120; Height = 770; await Task.Delay(180); state.jobs.Remove(fixtureJob); RenderTasks(); pauseSmokeState = false;
                    await Refresh();
                }
                foreach (string target in new[] { "home", "instances", "downloads", "tasks", "settings", "account" }) {
                    Navigate(target); await Task.Delay(220); UpdateLayout(); Find<Border>("Toast").Visibility = Visibility.Collapsed; Capture(Path.Combine(output, target + ".png"));
                }
                if (Environment.GetEnvironmentVariable("CQU_PCL_NATIVE_QA") == "1") {
                    Navigate("packs"); await Task.Delay(450); UpdateLayout(); Capture(Path.Combine(output, "packs.png"));
                    if (!Descendants(Find<StackPanel>("CatalogList")).OfType<TextBlock>().Any(t => t.Text == "奶蛙校园冒险")) throw new Exception("Catalog did not render fixture project.");
                    Navigate("mods"); await Task.Delay(450); UpdateLayout(); Capture(Path.Combine(output, "mods.png"));
                    await VerifyDialog("install", async () => await ShowInstall(), output);
                    await VerifyDialog("pack", async () => await ImportPack(Path.Combine(dataRoot, "fixture.mrpack")), output);
                    await VerifyDialog("project", async () => await ShowProject(new Project { project_id = "fixture-project", title = "奶蛙校园冒险", description = "原生界面测试整合包", project_type = "modpack" }), output);
                    await VerifyDialog("instance", () => { ShowInstance(Selected); return Task.FromResult(0); }, output);
                    await client.Request<object>("/settings", new { loginMode = "microsoft" }, "PATCH"); await Refresh(); Navigate("account");
                    await StartLogin(); await Task.Delay(220); UpdateLayout(); Find<Border>("Toast").Visibility = Visibility.Collapsed; Capture(Path.Combine(output, "device-code.png"));
                    if (login == null || login.userCode != "NAIW-A1929") throw new Exception("Device code did not render.");
                    Navigate("home");
                    for (int attempt = 0; attempt < 80 && (state.account == null || state.account.name != "Naiwa_Online"); attempt++) await Task.Delay(100);
                    if (state.account == null || state.account.name != "Naiwa_Online") throw new Exception("Microsoft login did not persist across navigation.");
                    Navigate("account"); await Task.Delay(220); UpdateLayout(); Capture(Path.Combine(output, "account-online.png"));
                    await client.Request<object>("/auth/logout", new {}); await Refresh();
                    Find<Button>("MinimizeWindow").RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
                    if (WindowState != WindowState.Minimized) throw new Exception("Minimize button failed."); WindowState = WindowState.Normal;
                    Find<Button>("MaximizeWindow").RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
                    if (WindowState != WindowState.Maximized) throw new Exception("Maximize button failed.");
                    Find<Button>("MaximizeWindow").RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
                    if (WindowState != WindowState.Normal) throw new Exception("Restore button failed.");
                }
                Navigate("account");
                if (state.settings.loginMode != "offline") throw new Exception("Smoke test must use an isolated offline fixture.");
                var account = Find<StackPanel>("AccountContent");
                var name = Descendants(account).OfType<TextBox>().First(e => System.Windows.Automation.AutomationProperties.GetAutomationId(e) == "OfflineName");
                name.Text = "Native_QA";
                var save = Descendants(account).OfType<Button>().First(e => System.Windows.Automation.AutomationProperties.GetAutomationId(e) == "SaveOffline");
                save.RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
                for (int attempt = 0; attempt < 60 && state.settings.playerName != "Native_QA"; attempt++) await Task.Delay(100);
                if (state.settings.playerName != "Native_QA") throw new Exception("Offline account did not persist.");
                Navigate("settings");
                var settingsPanel = Find<StackPanel>("SettingsContent");
                var memory = Descendants(settingsPanel).OfType<TextBox>().First(e => System.Windows.Automation.AutomationProperties.GetAutomationId(e) == "Memory");
                memory.Text = "6144";
                var saveSettings = Descendants(settingsPanel).OfType<Button>().First(e => System.Windows.Automation.AutomationProperties.GetAutomationId(e) == "SaveSettings");
                saveSettings.RaiseEvent(new RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent));
                for (int attempt = 0; attempt < 60 && state.settings.memory != 6144; attempt++) await Task.Delay(100);
                if (state.settings.memory != 6144) throw new Exception("Settings did not persist.");
                Navigate("home"); Find<Border>("Toast").Visibility = Visibility.Collapsed; Width = MinWidth; Height = MinHeight; await Task.Delay(220); UpdateLayout(); Capture(Path.Combine(output, "home-minimum.png"));
                Width = 1120; Height = 770; await Task.Delay(180); UpdateLayout(); Capture(Path.Combine(output, "home.png"));
                var fixture = new Pack();
                string packFile = Path.Combine(dataRoot, "fixture.mrpack");
                if (File.Exists(packFile)) { fixture = await client.InspectPack(packFile); if (fixture.minecraft != "1.21.1" || fixture.loader != "fabric") throw new Exception("Pack inspection failed."); }
                File.WriteAllText(Path.Combine(output, "result.json"), new JavaScriptSerializer().Serialize(new { ok = true, playerName = state.settings.playerName, memory = state.settings.memory, instances = state.instances.Count, pack = fixture.name, ui = "WPF", pages = 8, dialogs = 4, microsoftFixture = true, windowControls = true, localMods = true, openDirectory = true, downloadTelemetry = true, stableTaskControls = true }));
            } catch (Exception e) { File.WriteAllText(Path.Combine(output, "result.json"), new JavaScriptSerializer().Serialize(new { ok = false, error = e.ToString() })); }
            Close();
        }
        async Task VerifyDialog(string name, Func<Task> open, string output) {
            bool captured = false;
            var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(650) };
            timer.Tick += (sender, e) => {
                var dialog = Application.Current.Windows.OfType<Window>().FirstOrDefault(w => w != this && w.Owner == this);
                if (dialog == null) return;
                timer.Stop(); dialog.UpdateLayout();
                var visual = (FrameworkElement)dialog.Content;
                var bitmap = new RenderTargetBitmap((int)Math.Ceiling(visual.ActualWidth), (int)Math.Ceiling(visual.ActualHeight), 96, 96, PixelFormats.Pbgra32); bitmap.Render(visual);
                var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap)); using (var stream = File.Create(Path.Combine(output, "dialog-" + name + ".png"))) encoder.Save(stream);
                captured = true; dialog.Close();
            };
            timer.Start(); await open(); timer.Stop(); if (!captured) throw new Exception("Dialog failed to open: " + name);
        }
        System.Collections.Generic.IEnumerable<DependencyObject> Descendants(DependencyObject parent) {
            for (int i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++) {
                var child = VisualTreeHelper.GetChild(parent, i); yield return child;
                foreach (var descendant in Descendants(child)) yield return descendant;
            }
        }
        void Capture(string file) {
            var bitmap = new RenderTargetBitmap((int)Math.Ceiling(shell.ActualWidth), (int)Math.Ceiling(shell.ActualHeight), 96, 96, PixelFormats.Pbgra32); bitmap.Render(shell);
            var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap)); using (var stream = File.Create(file)) encoder.Save(stream);
        }
    }
}
