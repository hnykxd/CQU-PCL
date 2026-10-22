using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using System.Windows.Shell;
using Microsoft.Win32;

namespace CquPcl.Native {
    sealed partial class LauncherWindow : Window {
        readonly Grid shell;
        readonly BackendClient client;
        readonly string workspace, dataRoot, host;
        readonly bool dev;
        LauncherState state;
        string page = "home", catalogQuery = "", accountSignature = "";
        bool updatingSelector, closing, connected, launching, activationRequested;
        int toastRevision;
        int catalogRevision, loginRevision;
        LoginFlow login;
        string loginError = "";
        readonly string[] pages = { "HomePage", "InstancesPage", "DownloadsPage", "CatalogPage", "TasksPage", "AccountPage", "SettingsPage" };
        readonly string[] navigation = { "NavHome", "NavInstances", "NavDownloads", "NavPacks", "NavMods", "NavTasks", "NavAccount", "NavSettings" };
        readonly Dictionary<Window, TextBlock> dialogErrors = new Dictionary<Window, TextBlock>();
        readonly Dictionary<string, TaskView> taskViews = new Dictionary<string, TaskView>();
        TextBlock taskSummary;
        sealed class TaskView {
            public Border card;
            public TextBlock title, status, file, metrics, percent;
            public ProgressBar progress;
            public WrapPanel actions;
            public string actionStatus;
        }
        public LauncherWindow(string workspace, string dataRoot, string host, bool dev, SingleInstance ownership) {
            this.workspace = workspace; this.dataRoot = dataRoot; this.host = host; this.dev = dev;
            Title = "CQU PCL"; Width = 1120; Height = 770; MinWidth = 920; MinHeight = 660;
            WindowStyle = WindowStyle.None; Background = Brushes.White;
            WindowChrome.SetWindowChrome(this, new WindowChrome { CaptionHeight = 38, ResizeBorderThickness = new Thickness(6), GlassFrameThickness = new Thickness(0), CornerRadius = new CornerRadius(0), UseAeroCaptionButtons = false });
            WindowStartupLocation = WindowStartupLocation.CenterScreen; FontFamily = new FontFamily("Microsoft YaHei UI");
            using (var source = typeof(Program).Assembly.GetManifestResourceStream("Shell.xaml")) shell = (Grid)XamlReader.Load(source);
            Content = shell;
            using (var logo = typeof(Program).Assembly.GetManifestResourceStream("brand-logo.png")) {
                if (logo != null) { var bitmap = new BitmapImage(); bitmap.BeginInit(); bitmap.StreamSource = logo; bitmap.CacheOption = BitmapCacheOption.OnLoad; bitmap.EndInit(); bitmap.Freeze(); Find<Image>("BrandLogo").Source = bitmap; Find<Image>("DropLogo").Source = bitmap; }
            }
            string icon = Path.Combine(workspace, dev ? "public/icon.ico" : "icon.ico");
            if (File.Exists(icon)) { try { Icon = BitmapFrame.Create(new Uri(icon)); } catch (FileFormatException) { /* Windows still uses the executable's embedded icon. */ } }
            client = new BackendClient(dataRoot, ownership);
            client.StateChanged += value => Dispatch(() => ApplyState(value));
            client.FocusRequested += () => Dispatch(() => { if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal; Show(); Activate(); });
            client.Disconnected += error => Dispatch(() => { connected = false; Notify(error, true); });
            Find<Button>("MinimizeWindow").Click += (sender, e) => WindowState = WindowState.Minimized;
            Find<Button>("MaximizeWindow").Click += (sender, e) => WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
            Find<Button>("CloseWindow").Click += (sender, e) => Close();
            StateChanged += (sender, e) => Find<Button>("MaximizeWindow").Content = WindowState == WindowState.Maximized ? "▣" : "□";
            foreach (string name in navigation) {
                var button = Find<Button>(name);
                button.Click += (sender, e) => Navigate((string)((Button)sender).Tag);
            }
            Find<Button>("AccountShortcut").Click += (sender, e) => Navigate("account");
            Find<Button>("LaunchButton").Click += async (sender, e) => {
                var instance = Selected;
                if (instance == null) { await ShowInstall(); return; }
                if (instance.edition != "java") { await Run((Button)sender, () => OpenDirectory(instance.directory), "服务端 ZIP 已下载，请按官方说明启动。"); return; }
                if (launching) return;
                launching = true;
                try { await Run((Button)sender, async () => { await client.Request<object>("/instances/" + instance.id + "/launch", new {}); }, "游戏正在启动"); }
                finally { launching = false; Find<Button>("LaunchButton").IsEnabled = Selected == null || (Selected.status == "ready" && !Selected.running); }
            };
            Find<Button>("WorldSettingsButton").Click += (sender, e) => { if (Selected != null) ShowInstance(Selected); };
            Find<Button>("CreateWorldButton").Click += async (sender, e) => await ShowInstall();
            Find<Button>("ImportPackButton").Click += async (sender, e) => await ImportPack();
            Find<ComboBox>("WorldSelector").SelectionChanged += async (sender, e) => {
                if (updatingSelector) return;
                var chosen = ((ComboBox)sender).SelectedItem as Instance;
                if (chosen != null && chosen.id != state.selectedId) await Run(null, async () => { await client.Request<object>("/selected", new { id = chosen.id }); await Refresh(); if (page == "mods") await SearchCatalog(); });
            };
            Find<Button>("SearchButton").Click += async (sender, e) => await SearchCatalog();
            Find<TextBox>("SearchBox").KeyDown += async (sender, e) => { if (e.Key == Key.Enter) await SearchCatalog(); };
            AllowDrop = true;
            PreviewDragOver += (sender, e) => { if (e.Data.GetDataPresent(DataFormats.FileDrop)) { e.Effects = connected ? DragDropEffects.Copy : DragDropEffects.None; Find<Border>("DropHint").Visibility = connected ? Visibility.Visible : Visibility.Collapsed; e.Handled = true; } };
            PreviewDragLeave += (sender, e) => { var position = e.GetPosition(this); if (position.X <= 0 || position.Y <= 0 || position.X >= ActualWidth || position.Y >= ActualHeight) Find<Border>("DropHint").Visibility = Visibility.Collapsed; };
            Drop += async (sender, e) => {
                if (!connected || !e.Data.GetDataPresent(DataFormats.FileDrop)) return;
                Find<Border>("DropHint").Visibility = Visibility.Collapsed;
                var files = (string[])e.Data.GetData(DataFormats.FileDrop);
                if (files.Length != 1) { Notify("请一次导入一个整合包。", true); return; }
                await ImportPack(files[0]);
            };
            Loaded += async (sender, e) => {
                if (activationRequested) { activationRequested = false; ActivateWindow(); }
                Find<Grid>("PageHost").IsEnabled = false;
                foreach (string name in navigation) Find<Button>(name).IsEnabled = false;
                try {
                    await client.Start(workspace, dataRoot, host, dev);
                    ApplyState(await client.Request<LauncherState>("/state")); connected = true; Find<Grid>("PageHost").IsEnabled = true;
                    foreach (string name in navigation) Find<Button>(name).IsEnabled = true;
                    // Release the large one-time ZIP extraction buffers before normal use.
                    if (!dev) { GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect(); }
                    Navigate("home"); Notify("准备好了，开始你的冒险。");
                    if (smokeTest) await SmokeTest();
                } catch (Exception error) { File.WriteAllText(Path.Combine(dataRoot, "startup-error.log"), error.ToString()); Notify(error.Message, true); if (!smokeTest) MessageBox.Show(this, error.Message, "启动失败"); Close(); }
            };
            Closed += (sender, e) => { closing = true; loginRevision++; client.Dispose(); };
        }
        T Find<T>(string name) where T : class { return shell.FindName(name) as T; }
        void Dispatch(Action action) { if (!closing) Dispatcher.BeginInvoke((Action)(() => { if (!closing) action(); })); }
        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr window);
        public void RequestActivation() {
            Dispatch(() => { if (!IsLoaded) { activationRequested = true; return; } ActivateWindow(); });
        }
        void ActivateWindow() {
            if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
            Show();
            // Bring a modal dialog with its owner so repeated launches remain usable.
            var target = Application.Current.Windows.OfType<Window>().LastOrDefault(w => w.Owner == this && w.IsVisible) ?? this;
            target.Activate(); SetForegroundWindow(new System.Windows.Interop.WindowInteropHelper(target).Handle);
        }
        Instance Selected { get { return state == null ? null : state.instances.FirstOrDefault(i => i.id == state.selectedId); } }
        int ModCount(Instance instance) { return instance.mods == null ? 0 : instance.mods.Count(m => m.enabled != false && m.recognized != false); }
        Brush Brush(string hex) { return (Brush)new BrushConverter().ConvertFromString(hex); }
        TextBlock Text(string value, double size = 13, string color = "#22354D") { return new TextBlock { Text = value ?? "", FontSize = size, Foreground = Brush(color), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 9) }; }
        Button Button(string label, Func<Task> action, bool primary = false) {
            var button = new Button { Content = label, Margin = new Thickness(0, 0, 9, 8) };
            if (primary) button.Style = (Style)shell.Resources["Primary"];
            if (action != null) button.Click += async (sender, e) => await Run(button, action);
            return button;
        }
        WrapPanel Actions(params UIElement[] elements) { var panel = new WrapPanel { Margin = new Thickness(0, 10, 0, 0) }; foreach (var element in elements) panel.Children.Add(element); return panel; }
        Border Card(UIElement content) { return new Border { Background = Brushes.White, BorderBrush = Brush("#E1E8F2"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(11), Padding = new Thickness(24), Margin = new Thickness(0, 0, 0, 14), Child = content }; }
        TextBox Field(StackPanel panel, string label, string value, string automationId = null) {
            panel.Children.Add(Text(label, 12, "#68809E"));
            var input = new TextBox { Text = value ?? "", Margin = new Thickness(0, 0, 0, 17) };
            if (automationId != null) System.Windows.Automation.AutomationProperties.SetAutomationId(input, automationId);
            panel.Children.Add(input); return input;
        }
        ComboBox Choice(StackPanel panel, string label, IEnumerable<object> items, object selected = null) {
            panel.Children.Add(Text(label, 12, "#68809E"));
            var combo = new ComboBox { Margin = new Thickness(0, 0, 0, 17) };
            foreach (var item in items) combo.Items.Add(item);
            if (selected != null) combo.SelectedItem = selected; else if (combo.Items.Count > 0) combo.SelectedIndex = 0;
            panel.Children.Add(combo); return combo;
        }
        async void Notify(string value, bool error = false) {
            if (closing) return;
            Find<TextBlock>("StatusMessage").Text = value; Find<TextBlock>("StatusMessage").Foreground = Brush(error ? "#C94F57" : "#6480A4");
            if (!connected) return;
            int revision = ++toastRevision; var toast = Find<Border>("Toast"); Find<TextBlock>("ToastText").Text = value;
            toast.Background = Brush(error ? "#A94D58" : "#174C83"); toast.Visibility = Visibility.Visible;
            toast.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(160)));
            await Task.Delay(3800);
            if (!closing && revision == toastRevision) toast.Visibility = Visibility.Collapsed;
        }
        async Task<bool> Run(Button button, Func<Task> action, string success = null) {
            object label = button == null ? null : button.Content;
            if (button != null) { button.IsEnabled = false; button.Content = "请稍候…"; }
            var owner = button == null ? null : Window.GetWindow(button);
            if (owner != null && dialogErrors.ContainsKey(owner)) dialogErrors[owner].Visibility = Visibility.Collapsed;
            try { await action(); if (success != null) Notify(success); return true; }
            catch (Exception e) { Notify(e.Message, true); if (owner != null && dialogErrors.ContainsKey(owner)) { dialogErrors[owner].Text = e.Message; dialogErrors[owner].Visibility = Visibility.Visible; } return false; }
            finally { if (button != null) { button.Content = label; button.IsEnabled = true; } }
        }
        async Task Refresh() { ApplyState(await client.Request<LauncherState>("/state")); }
        void ApplyState(LauncherState value) {
            if (smokeTest && pauseSmokeState) return;
            state = value;
            string nextSignature = (state.account == null ? "" : state.account.name + state.account.uuid + state.account.expiresAt) + state.settings.loginMode;
            bool accountChanged = nextSignature != accountSignature; accountSignature = nextSignature;
            Find<TextBlock>("ProfileName").Text = state.settings.loginMode == "microsoft" ? (state.account == null ? "尚未登录" : state.account.name) : state.settings.playerName;
            Find<TextBlock>("ProfileMode").Text = state.settings.loginMode == "microsoft" ? "Microsoft 正版" : "离线登录";
            Find<TextBlock>("SourceStatus").Text = (state.settings.source == "bmclapi" ? "BMCLAPI 镜像" : "官方源") + "   ·   " + state.jobs.Count(j => j.status == "running" || j.status == "queued") + " 个活动任务";
            var selected = Selected;
            Find<TextBlock>("WorldName").Text = selected == null ? "创造你的第一个世界" : selected.name;
            Find<TextBlock>("WorldSummary").Text = selected == null ? "从原版开始，也可以导入你喜欢的整合包。" : selected.Summary;
            Find<TextBlock>("WorldStatus").Text = selected == null ? "存档、模组与配置，独立存放。" : (selected.running ? "游戏运行中" : Labels.Status(selected.status)) + "  ·  " + ModCount(selected) + " 个模组" + (String.IsNullOrEmpty(selected.error) ? "" : "  ·  " + selected.error);
            Find<Button>("LaunchButton").Content = selected == null ? "▶   开启新世界" : selected.edition == "bedrock-server" ? "打开服务端目录" : "▶   启动游戏";
            Find<Button>("LaunchButton").IsEnabled = !launching && (selected == null || (selected.status == "ready" && !selected.running));
            Find<Button>("WorldSettingsButton").IsEnabled = selected != null;
            var selector = Find<ComboBox>("WorldSelector"); updatingSelector = true;
            selector.ItemsSource = state.instances; selector.SelectedItem = selected; updatingSelector = false;
            DateTime last;
            Find<TextBlock>("LastPlayed").Text = selected != null && DateTime.TryParse(selected.lastPlayed, out last) ? "上次游玩 " + last.ToLocalTime().ToString("yyyy/MM/dd HH:mm") : "等待第一次冒险";
            if (page == "instances") RenderInstances();
            if (page == "tasks") RenderTasks();
            if (page == "downloads") UpdateDownloadSummary();
            if (page == "account" && accountChanged) RenderAccount();
        }
        void Navigate(string next) {
            if (state == null) return;
            page = next; catalogRevision++;
            foreach (string name in pages) Find<FrameworkElement>(name).Visibility = Visibility.Collapsed;
            foreach (string name in navigation) {
                var button = Find<Button>(name); bool active = (string)button.Tag == next;
                button.Background = Brush(active ? "#E8EFF9" : "#FFFFFF"); button.Foreground = Brush(active ? "#174C83" : "#627690"); button.FontWeight = active ? FontWeights.SemiBold : FontWeights.Normal;
            }
            string title = "", subtitle = "", surface = "HomePage";
            switch (next) {
                case "home": title = "开始游戏"; subtitle = "你的下一个世界，从这里开始。"; break;
                case "instances": title = "我的世界"; subtitle = "每一个世界，都有自己的空间。"; surface = "InstancesPage"; RenderInstances(); break;
                case "downloads": title = "下载游戏"; subtitle = "从最初的方块，到最新的冒险。"; surface = "DownloadsPage"; RenderDownloads(); break;
                case "packs": title = "发现整合包"; subtitle = "精心组合的世界，开箱即玩。"; surface = "CatalogPage"; break;
                case "mods": title = "模组探索"; subtitle = "为你的世界，添加一点可能。"; surface = "CatalogPage"; break;
                case "tasks": title = "下载任务"; subtitle = "每一份期待，都在抵达。"; surface = "TasksPage"; RenderTasks(); break;
                case "account": title = "玩家账户"; subtitle = "选择登录方式，管理你的游戏角色。"; surface = "AccountPage"; RenderAccount(); break;
                case "settings": title = "启动器设置"; subtitle = "让 CQU PCL 更适合你。"; surface = "SettingsPage"; RenderSettings(); break;
            }
            Find<TextBlock>("PageTitle").Text = title; Find<TextBlock>("PageSubtitle").Text = subtitle;
            Find<FrameworkElement>(surface).Visibility = Visibility.Visible;
            if (SystemParameters.ClientAreaAnimation) {
                var transition = Find<Grid>("PageHost"); transition.RenderTransform = new TranslateTransform();
                transition.BeginAnimation(OpacityProperty, new DoubleAnimation(0.3, 1, TimeSpan.FromMilliseconds(180)));
                ((TranslateTransform)transition.RenderTransform).BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(7, 0, TimeSpan.FromMilliseconds(180)) { EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut } });
            }
            if (next == "mods" || next == "packs") {
                Find<TextBox>("SearchBox").Text = ""; catalogQuery = "";
                BeginCatalogSearch();
            }
        }
        void RenderInstances() {
            var panel = Find<StackPanel>("InstancesList"); panel.Children.Clear();
            panel.Children.Add(Actions(Button("＋ 创建世界", async () => await ShowInstall(), true), Button("↑ 导入整合包", async () => await ImportPack())));
            if (state.instances.Count == 0) { panel.Children.Add(Card(Text("还没有世界。创建一个原版世界，或导入 .mrpack / CurseForge ZIP 整合包。", 15))); return; }
            foreach (var item in state.instances) {
                var instance = item;
                var content = new StackPanel(); content.Children.Add(Text(instance.name, 19)); content.Children.Add(Text(instance.Summary, 12, "#7D91AB"));
                content.Children.Add(Text((instance.running ? "游戏运行中" : Labels.Status(instance.status)) + " · " + ModCount(instance) + " 个模组 · 独立目录", 11, "#748DAA"));
                if (!String.IsNullOrEmpty(instance.error)) content.Children.Add(Text(instance.error, 12, "#C94F57"));
                var select = Button(instance.id == state.selectedId ? "✓ 当前世界" : "选择世界", async () => { await client.Request<object>("/selected", new { id = instance.id }); await Refresh(); Navigate("home"); }, true);
                content.Children.Add(Actions(select, Button("世界设置", () => { ShowInstance(instance); return Task.FromResult(0); }), Button("打开目录", () => OpenDirectory(instance.directory))));
                panel.Children.Add(Card(content));
            }
        }
        void RenderTasks() {
            var panel = Find<StackPanel>("TasksList");
            if (state.jobs.Count == 0) { taskViews.Clear(); taskSummary = null; panel.Children.Clear(); panel.Children.Add(Card(Text("目前没有下载任务。创建世界或安装整合包后，进度会显示在这里。", 15))); return; }
            if (taskSummary == null || taskSummary.Parent == null) { panel.Children.Clear(); taskSummary = Text("", 13, "#68809E"); panel.Children.Add(taskSummary); }
            taskSummary.Text = state.jobs.Count(j => j.status == "running" || j.status == "queued") + " 个活动任务  ·  " + FormatBytes(state.jobs.Sum(j => j.speedBytesPerSecond)) + "/s  ·  " + state.jobs.Count + " 条记录";
            foreach (string id in taskViews.Keys.Where(id => !state.jobs.Any(job => job.id == id)).ToList()) { panel.Children.Remove(taskViews[id].card); taskViews.Remove(id); }
            int index = 1;
            foreach (var item in state.jobs) {
                var job = item; TaskView view;
                if (!taskViews.TryGetValue(job.id, out view)) {
                    view = new TaskView { title = Text("", 17), status = Text("", 12, "#7D91AB"), file = Text("", 12), metrics = Text("", 12, "#68809E"), percent = Text("", 10, "#8FA0B6"), progress = new ProgressBar { Maximum = 100, Margin = new Thickness(0, 8, 0, 5) }, actions = Actions() };
                    view.file.TextWrapping = TextWrapping.NoWrap; view.file.TextTrimming = TextTrimming.CharacterEllipsis;
                    var content = new StackPanel(); foreach (var element in new UIElement[] { view.title, view.status, view.file, view.metrics, view.progress, view.percent, view.actions }) content.Children.Add(element);
                    view.card = Card(content); taskViews.Add(job.id, view);
                }
                if (panel.Children.IndexOf(view.card) != index) { panel.Children.Remove(view.card); panel.Children.Insert(index, view.card); } index++;
                view.title.Text = job.title; view.status.Text = Labels.Status(job.status) + " · " + job.stage; view.status.Foreground = Brush(job.status == "error" ? "#C94F57" : "#7D91AB");
                var files = job.activeFiles ?? new List<DownloadFile>();
                view.file.Text = files.Count > 0 ? "正在下载：" + files[0].fileName + (files.Count > 1 ? "  （另有 " + (files.Count - 1) + " 个文件）" : "") : String.IsNullOrEmpty(job.currentFile) ? (job.status == "queued" ? "等待任务开始" : "当前没有文件传输") : "最近文件：" + job.currentFile;
                view.file.ToolTip = files.Count > 0 ? String.Join(Environment.NewLine, files.Select(f => f.fileName + "  ·  " + FormatBytes(f.receivedBytes) + (f.totalBytes > 0 ? " / " + FormatBytes(f.totalBytes) : ""))) : job.currentFile;
                view.metrics.Text = FormatBytes(job.speedBytesPerSecond) + "/s  ·  累计接收 " + FormatBytes(job.downloadedBytes) + (job.connections > 0 ? "  ·  " + job.connections + " 个连接" : "");
                view.progress.Value = job.progress; view.percent.Text = Math.Round(job.progress) + "%";
                string actionStatus = job.status + job.instanceId;
                if (view.actionStatus != actionStatus) {
                    view.actionStatus = actionStatus; view.actions.Children.Clear();
                    if (job.status == "queued" || job.status == "running") view.actions.Children.Add(Button("取消任务", async () => { await client.Request<object>("/jobs/" + job.id + "/cancel", new {}); await Refresh(); Notify("正在取消任务"); }));
                    if (job.status == "error" || job.status == "cancelled") {
                        var instance = state.instances.FirstOrDefault(i => i.id == job.instanceId && i.edition == "java");
                        if (instance != null) view.actions.Children.Add(Button("重新安装", async () => { await client.Request<object>("/instances/" + instance.id + "/retry", new {}); await Refresh(); }));
                    }
                    var remove = Button("删除任务", async () => { await client.Request<object>("/jobs/" + job.id, null, "DELETE"); await Refresh(); Notify("任务已删除。"); });
                    remove.ToolTip = "停止此任务并移除记录，保留世界与已下载文件"; view.actions.Children.Add(remove);
                }
            }
        }
        string FormatBytes(double bytes) {
            if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).ToString("0.00") + " GB";
            if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).ToString("0.00") + " MB";
            if (bytes >= 1024) return (bytes / 1024).ToString("0.0") + " KB";
            return Math.Max(0, bytes).ToString("0") + " B";
        }
        void UpdateDownloadSummary() {
            var summary = Find<StackPanel>("DownloadsContent").Children.OfType<Border>().FirstOrDefault(b => (string)b.Tag == "DownloadSummary");
            if (summary == null) return;
            var content = (StackPanel)summary.Child;
            ((TextBlock)content.Children[1]).Text = state.jobs.Count(j => j.status == "running" || j.status == "queued") + " 个活动任务  ·  " + FormatBytes(state.jobs.Sum(j => j.speedBytesPerSecond)) + "/s";
        }
        void RenderDownloads() {
            var panel = Find<StackPanel>("DownloadsContent"); panel.Children.Clear();
            var queue = new StackPanel(); queue.Children.Add(Text("下载进度", 19)); queue.Children.Add(Text("", 12, "#68809E")); queue.Children.Add(Actions(Button("查看下载任务", () => { Navigate("tasks"); return Task.FromResult(0); })));
            var summary = Card(queue); summary.Tag = "DownloadSummary"; panel.Children.Add(summary); UpdateDownloadSummary();
            var java = new StackPanel(); java.Children.Add(Text("Minecraft Java Edition", 21));
            java.Children.Add(Text("原版、Fabric、Forge、Quilt 与 NeoForge。自动安装游戏、资源与所需 Java。", 13, "#7D91AB"));
            java.Children.Add(Actions(Button("＋ 选择版本并安装", async () => await ShowInstall(), true))); panel.Children.Add(Card(java));
            var bedrock = new StackPanel(); bedrock.Children.Add(Text("Minecraft 基岩版服务端", 19));
            bedrock.Children.Add(Text("下载 Minecraft 官方 Windows / Linux 服务端 ZIP，解压后按官方说明运行。", 13, "#7D91AB"));
            bedrock.Children.Add(Actions(Button("下载官方服务端", async () => await ShowBedrock()), Button("打开 Minecraft 官网", () => { OpenExternal("https://www.minecraft.net/download"); return Task.FromResult(0); })));
            panel.Children.Add(Card(bedrock));
            var imports = new StackPanel(); imports.Children.Add(Text("已经有整合包？", 19)); imports.Children.Add(Text("支持 Modrinth .mrpack 和 CurseForge ZIP。识别游戏版本与加载器后安装到独立世界。", 13, "#7D91AB")); imports.Children.Add(Actions(Button("导入本地整合包", async () => await ImportPack()))); panel.Children.Add(Card(imports));
        }
        async Task SearchCatalog() {
            if (state == null || (page != "mods" && page != "packs")) return;
            int revision = ++catalogRevision; string type = page == "mods" ? "mod" : "modpack";
            var target = Selected; bool compatible = type == "mod" && target != null && target.edition == "java";
            catalogQuery = Find<TextBox>("SearchBox").Text.Trim(); var list = Find<StackPanel>("CatalogList"); list.Children.Clear(); list.Children.Add(Text("正在连接 Modrinth…", 14, "#8495AC"));
            Find<TextBlock>("CatalogHint").Text = compatible ? "筛选 " + target.Summary + " 兼容模组。可在首页切换世界。" : type == "mod" ? "请先选择已安装的 Java 世界，再安装兼容模组。" : "由 Modrinth 提供，整合包将安装为新的独立世界。";
            try {
                string query = "?type=" + type + "&query=" + Uri.EscapeDataString(catalogQuery) + (compatible ? "&minecraft=" + Uri.EscapeDataString(target.minecraft) + "&loader=" + target.loader : "");
                var result = await client.Request<SearchResult>("/catalog/search" + query);
                if (revision != catalogRevision || closing) return;
                list.Children.Clear();
                if (result.hits.Count == 0) list.Children.Add(Card(Text("没有找到匹配的项目。试试其他名称或游戏版本。", 14)));
                foreach (var item in result.hits) {
                    var project = item; var content = new StackPanel(); content.Children.Add(Text(project.title, 19));
                    content.Children.Add(Text("by " + project.author + " · " + project.downloads.ToString("N0") + " 次下载", 11, "#8B9CB2")); content.Children.Add(Text(project.description, 13, "#6E84A0"));
                    var details = Button("选择版本", async () => await ShowProject(project), true);
                    if (type == "mod") details.IsEnabled = compatible && target.status == "ready";
                    content.Children.Add(Actions(details)); list.Children.Add(Card(content));
                }
            } catch (Exception e) {
                if (revision != catalogRevision) return;
                list.Children.Clear(); var retry = new StackPanel(); retry.Children.Add(Text("内容平台暂时无法连接", 17)); retry.Children.Add(Text(e.Message, 12, "#C94F57")); retry.Children.Add(Actions(Button("重试", async () => await SearchCatalog()), Button("导入本地整合包", async () => await ImportPack()))); list.Children.Add(Card(retry));
            }
        }
        async void BeginCatalogSearch() { await SearchCatalog(); }
        Window Dialog(string title, StackPanel content, double width = 540) {
            var window = new Window { Title = title, Owner = this, Width = width, SizeToContent = SizeToContent.Height, MaxHeight = Math.Max(500, ActualHeight - 40), ResizeMode = ResizeMode.CanResize, MinWidth = 440, WindowStartupLocation = WindowStartupLocation.CenterOwner, Background = Brush("#F3F6FB"), FontFamily = FontFamily, ShowInTaskbar = false };
            window.Resources = shell.Resources; window.Icon = Icon;
            content.Margin = new Thickness(26); var scroll = new ScrollViewer { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
            var layout = new DockPanel { Background = Brush("#F3F6FB") };
            var error = Text("", 12, "#A94D58"); error.Margin = new Thickness(26, 0, 26, 18); error.Visibility = Visibility.Collapsed;
            DockPanel.SetDock(error, Dock.Bottom); layout.Children.Add(error); layout.Children.Add(scroll); window.Content = layout;
            dialogErrors[window] = error; window.Closed += (sender, e) => dialogErrors.Remove(window);
            window.PreviewKeyDown += (sender, e) => { if (e.Key == Key.Escape) { window.Close(); e.Handled = true; } };
            if (SystemParameters.ClientAreaAnimation) window.Loaded += (sender, e) => layout.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(150)));
            return window;
        }
        async Task ShowInstall() {
            var content = new StackPanel(); content.Children.Add(Text("创建一个新世界", 23)); content.Children.Add(Text("选择准确的游戏与加载器版本，安装到独立目录。", 12, "#8293AA"));
            var name = Field(content, "世界名称", "", "InstanceName"); name.MaxLength = 80;
            var versions = Choice(content, "Minecraft 版本", new object[0]);
            var snapshots = new CheckBox { Content = "包含快照与历史测试版本", Margin = new Thickness(0, 0, 0, 17) }; content.Children.Add(snapshots);
            var loaders = new[] { "vanilla", "fabric", "forge", "quilt", "neoforge" };
            var loader = Choice(content, "模组加载器", loaders.Select(Labels.Loader).Cast<object>());
            var loaderVersion = Choice(content, "加载器版本", new object[0]); loaderVersion.IsEnabled = false;
            var errorText = Text("正在读取官方版本列表…", 12, "#8293AA"); content.Children.Add(errorText);
            var window = Dialog("创建世界", content); bool closed = false, loading = true; int revision = 0; List<GameVersion> manifest = null;
            window.Closed += (sender, e) => { closed = true; revision++; };
            var install = Button("创建并安装", null, true); install.IsEnabled = false;
            content.Children.Add(Actions(install, Button("取消", () => { window.Close(); return Task.FromResult(0); })));
            Func<Task> updateLoader = async () => {
                int attempt = ++revision; string selectedLoader = loaders[Math.Max(0, loader.SelectedIndex)]; var selectedVersion = versions.SelectedItem as GameVersion;
                loaderVersion.Items.Clear(); loaderVersion.IsEnabled = selectedLoader != "vanilla"; install.IsEnabled = false;
                if (selectedVersion == null) return;
                if (selectedLoader == "vanilla") { errorText.Text = "所需 Java 运行环境会自动安装。"; install.IsEnabled = !loading; return; }
                errorText.Text = "正在查询兼容加载器…";
                try {
                    var result = await client.Request<LoaderManifest>("/catalog/loaders?loader=" + selectedLoader + "&minecraft=" + Uri.EscapeDataString(selectedVersion.id));
                    if (closed || attempt != revision) return;
                    foreach (var item in result.versions) loaderVersion.Items.Add(item);
                    if (loaderVersion.Items.Count > 0) loaderVersion.SelectedIndex = 0;
                    install.IsEnabled = loaderVersion.SelectedItem != null; errorText.Text = install.IsEnabled ? "准确安装所选游戏与加载器。" : "该版本没有兼容的加载器，可选择原版或其他版本。";
                } catch (Exception e) { if (!closed && attempt == revision) errorText.Text = e.Message; }
            };
            versions.SelectionChanged += async (sender, e) => await updateLoader(); loader.SelectionChanged += async (sender, e) => await updateLoader();
            Action fillVersions = () => {
                if (manifest == null) return; var previous = versions.SelectedItem as GameVersion;
                versions.ItemsSource = manifest.Where(v => snapshots.IsChecked == true || v.type == "release").ToList();
                versions.SelectedItem = previous; if (versions.SelectedItem == null && versions.Items.Count > 0) versions.SelectedIndex = 0;
            };
            snapshots.Checked += (sender, e) => fillVersions(); snapshots.Unchecked += (sender, e) => fillVersions();
            Func<Task> loadVersions = async () => {
                install.IsEnabled = false;
                try { var result = await client.Request<GameManifest>("/catalog/versions"); if (closed) return; manifest = result.versions; loading = false; fillVersions(); await updateLoader(); }
                catch (Exception e) { if (!closed) errorText.Text = e.Message; }
            };
            content.Children.Add(Actions(Button("重新读取版本", loadVersions)));
            install.Click += async (sender, e) => {
                bool ok = await Run(install, async () => {
                    var selectedVersion = (GameVersion)versions.SelectedItem;
                    await client.Request<object>("/instances", new { name = String.IsNullOrWhiteSpace(name.Text) ? "Minecraft " + selectedVersion.id : name.Text.Trim(), minecraft = selectedVersion.id, loader = loaders[loader.SelectedIndex], loaderVersion = loaderVersion.SelectedItem as string ?? "" });
                    await Refresh(); window.Close(); Navigate("tasks"); Notify("世界已创建，开始下载游戏。");
                });
                if (!ok) errorText.Text = Find<TextBlock>("StatusMessage").Text;
            };
            window.Loaded += async (sender, e) => await loadVersions(); window.ShowDialog();
            await Task.FromResult(0);
        }
        async Task ImportPack(string file = null) {
            if (file == null) {
                var open = new OpenFileDialog { Title = "选择整合包", Filter = "Minecraft 整合包|*.mrpack;*.zip" };
                if (open.ShowDialog(this) != true) return; file = open.FileName;
            }
            if (!new[] { ".mrpack", ".zip" }.Contains(Path.GetExtension(file).ToLowerInvariant())) { Notify("请选择 .mrpack 或 CurseForge ZIP 整合包。", true); return; }
            await Run(null, async () => {
                Notify("正在识别整合包…"); var pack = await client.InspectPack(file);
                var content = new StackPanel(); content.Children.Add(Text("整合包已准备好", 23)); content.Children.Add(Text(pack.name, 18));
                content.Children.Add(Text("Minecraft " + pack.minecraft + " · " + Labels.Loader(pack.loader) + " " + pack.loaderVersion, 13, "#6685AB"));
                content.Children.Add(Text(pack.format + " · " + pack.version + " · " + pack.fileCount + " 个文件", 12, "#8293AA"));
                var name = Field(content, "世界名称", pack.name); name.MaxLength = 80; var window = Dialog("导入整合包", content);
                content.Children.Add(Actions(Button("安装整合包", async () => { await client.Request<object>("/packs/install", new { token = pack.token, name = name.Text.Trim() }); await Refresh(); window.Close(); Navigate("tasks"); Notify("整合包已加入安装队列。"); }, true)));
                window.ShowDialog();
            });
        }
        async Task ShowProject(Project project) {
            var content = new StackPanel(); content.Children.Add(Text(project.title, 23)); content.Children.Add(Text(project.description, 12, "#8293AA"));
            bool mod = project.project_type == "mod"; var target = Selected;
            ComboBox targets = null;
            if (mod) targets = Choice(content, "安装到世界", state.instances.Where(i => i.edition == "java" && i.status == "ready").Cast<object>(), target);
            var versions = Choice(content, "兼容项目版本", new object[0]); var hint = Text("正在获取版本…", 12, "#8293AA"); content.Children.Add(hint);
            var window = Dialog("项目版本", content); bool closed = false; int revision = 0;
            var install = Button(mod ? "安装模组" : "安装为新世界", null, true); install.IsEnabled = false;
            content.Children.Add(Actions(install)); window.Closed += (sender, e) => { closed = true; revision++; };
            Func<Task> load = async () => {
                int attempt = ++revision; install.IsEnabled = false; versions.Items.Clear(); var instance = targets == null ? null : targets.SelectedItem as Instance;
                if (mod && instance == null) { hint.Text = "请先安装并选择 Java 世界。"; return; }
                try {
                    string query = mod ? "?minecraft=" + Uri.EscapeDataString(instance.minecraft) + "&loader=" + instance.loader : "";
                    var result = await client.Request<ProjectManifest>("/catalog/projects/" + Uri.EscapeDataString(project.project_id) + "/versions" + query);
                    if (closed || attempt != revision) return;
                    foreach (var version in result.versions) versions.Items.Add(version);
                    versions.SelectedItem = result.versions.FirstOrDefault(v => v.version_type == "release") ?? result.versions.FirstOrDefault();
                    install.IsEnabled = versions.SelectedItem != null; hint.Text = install.IsEnabled ? mod ? "自动安装必要依赖，并校验文件。" : "安装到新的隔离世界。" : "没有找到适配的项目版本。";
                } catch (Exception e) { if (!closed && attempt == revision) hint.Text = e.Message; }
            };
            if (targets != null) targets.SelectionChanged += async (sender, e) => await load();
            install.Click += async (sender, e) => {
                bool ok = await Run(install, async () => {
                    var version = (ProjectVersion)versions.SelectedItem;
                    await client.Request<object>(mod ? "/instances/" + ((Instance)targets.SelectedItem).id + "/mods/install" : "/catalog/packs/install", new { versionId = version.id, name = project.title, projectId = project.project_id });
                    await Refresh(); window.Close(); Navigate("tasks"); Notify("已加入下载队列。");
                });
                if (!ok) hint.Text = Find<TextBlock>("StatusMessage").Text;
            };
            window.Loaded += async (sender, e) => await load(); window.ShowDialog(); await Task.FromResult(0);
        }
        async Task ShowBedrock() {
            var manifest = await client.Request<BedrockManifest>("/catalog/bedrock");
            var content = new StackPanel(); content.Children.Add(Text("下载基岩版官方服务端", 22));
            var version = Choice(content, "官方版本与平台", manifest.versions.Cast<object>());
            content.Children.Add(Text("下载官方 ZIP；Linux 包需要在 Linux 服务器上运行。", 12, "#8293AA")); var window = Dialog("基岩服务端", content);
            var install = Button("下载服务端", async () => { await client.Request<object>("/bedrock/install", new { url = ((BedrockVersion)version.SelectedItem).url }); await Refresh(); window.Close(); Navigate("tasks"); }, true);
            install.IsEnabled = version.SelectedItem != null; content.Children.Add(Actions(install)); window.ShowDialog();
        }
        void ShowInstance(Instance instance) {
            var content = new StackPanel(); content.Children.Add(Text("世界设置", 23)); content.Children.Add(Text(instance.Summary, 12, "#8293AA"));
            var name = Field(content, "世界名称", instance.name); name.MaxLength = 80;
            var directory = Field(content, "独立目录", instance.directory); directory.IsReadOnly = true;
            var window = Dialog("世界设置 · " + instance.name, content, 620);
            content.Children.Add(Actions(Button("保存名称", async () => { await client.Request<object>("/instances/" + instance.id, new { name = name.Text.Trim() }, "PATCH"); await Refresh(); Notify("名称已保存。"); }, true), Button("打开目录", () => OpenDirectory(instance.directory)), Button("复制目录", () => { Clipboard.SetText(instance.directory); Notify("目录已复制。"); return Task.FromResult(0); })));
            var updatesPanel = new StackPanel();
            var check = Button("检查模组与整合包更新", async () => {
                var updates = await client.Request<Updates>("/instances/" + instance.id + "/updates"); updatesPanel.Children.Clear();
                updatesPanel.Children.Add(Text(updates.mods.Count == 0 ? "模组已是兼容的最新版本。" : updates.mods.Count + " 个模组可以更新。", 14));
                foreach (var item in updates.mods) {
                    var mod = item; var row = new StackPanel(); row.Children.Add(Text((mod.name ?? mod.fileName) + " · " + mod.versionNumber + " → " + mod.latestVersion, 12));
                    row.Children.Add(Actions(Button("更新此模组", async () => { await client.Request<object>("/instances/" + instance.id + "/mods/install", new { versionId = mod.latestId }); await Refresh(); Notify("模组更新已加入队列。"); }))); updatesPanel.Children.Add(row);
                }
                if (updates.pack != null) updatesPanel.Children.Add(Actions(Button("创建新版整合包世界 · " + updates.pack.version_number, async () => { await client.Request<object>("/catalog/packs/install", new { versionId = updates.pack.id, projectId = instance.pack.projectId, name = instance.pack.name + " " + updates.pack.version_number }); await Refresh(); Notify("新版整合包将安装为独立世界。"); })));
            }); check.IsEnabled = instance.status == "ready" && instance.edition == "java";
            content.Children.Add(Actions(Button("运行日志", async () => {
                var result = await client.Request<LogResult>("/instances/" + instance.id + "/logs"); var log = new StackPanel();
                log.Children.Add(new TextBox { Text = String.IsNullOrEmpty(result.text) ? "游戏尚未产生运行日志。" : result.text, IsReadOnly = true, AcceptsReturn = true, TextWrapping = TextWrapping.NoWrap, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Height = 340, FontFamily = new FontFamily("Consolas") });
                Dialog("运行日志", log, 740).ShowDialog();
            }), check));
            if (instance.status == "error" && instance.edition == "java") content.Children.Add(Actions(Button("重新安装", async () => { await client.Request<object>("/instances/" + instance.id + "/retry", new {}); await Refresh(); window.Close(); Navigate("tasks"); })));
            content.Children.Add(updatesPanel);
            content.Children.Add(Text("本地模组", 15));
            var localMods = new TextBox { IsReadOnly = true, MaxHeight = 170, MinHeight = 60, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, TextWrapping = TextWrapping.Wrap };
            Action<Instance> renderMods = current => {
                localMods.Text = current.mods == null || current.mods.Count == 0 ? "mods 文件夹中尚无模组。" : String.Join(Environment.NewLine, current.mods.Select(m =>
                    (m.name ?? m.fileName) + (String.IsNullOrEmpty(m.versionNumber) ? "" : " · " + m.versionNumber) + (m.enabled == false ? " · 已禁用" : "") +
                    "  [" + m.fileName + "]" + (String.IsNullOrEmpty(m.warning) ? "" : " · " + m.warning)));
            };
            renderMods(instance); content.Children.Add(localMods);
            var rescan = Button("刷新本地模组", async () => { await client.Request<object>("/instances/" + instance.id + "/mods/scan", new {}); await Refresh(); renderMods(state.instances.First(i => i.id == instance.id)); Notify("本地模组已刷新。"); });
            rescan.IsEnabled = !instance.running && !state.jobs.Any(j => j.instanceId == instance.id && (j.status == "queued" || j.status == "running"));
            content.Children.Add(Actions(rescan, Button("打开 mods 文件夹", () => OpenDirectory(Path.Combine(instance.directory, "game", "mods")))));
            var delete = Button("删除世界", async () => {
                if (MessageBox.Show(window, "将永久删除「" + instance.name + "」的游戏、模组和存档。请先备份。", "确认删除世界", MessageBoxButton.YesNo, MessageBoxImage.Warning, MessageBoxResult.No) != MessageBoxResult.Yes) return;
                await client.Request<object>("/instances/" + instance.id, null, "DELETE"); await Refresh(); window.Close(); Notify("世界已删除。");
            }); delete.Foreground = Brush("#C94F57"); content.Children.Add(Actions(delete)); window.ShowDialog();
        }
        void RenderSettings() {
            var panel = Find<StackPanel>("SettingsContent"); panel.Children.Clear(); var content = new StackPanel(); content.Children.Add(Text("运行与下载", 19));
            var source = Choice(content, "下载源", new object[] { "BMCLAPI 镜像", "Minecraft 官方" }, state.settings.source == "bmclapi" ? "BMCLAPI 镜像" : "Minecraft 官方");
            content.Children.Add(Text("版本清单、游戏本体、资源、运行库、加载器和 Java 都使用所选下载源；镜像连接失败会自动切换到官方源。", 12, "#7D91AB"));
            var memory = Field(content, "游戏内存（MB，512–32768）", state.settings.memory.ToString(), "Memory");
            var java = Field(content, "Java 可执行文件路径（留空自动安装）", state.settings.javaPath, "JavaPath");
            content.Children.Add(Actions(Button("浏览 Java", () => { var open = new OpenFileDialog { Title = "选择 Java", Filter = "Java 可执行文件|java.exe;javaw.exe|所有文件|*.*" }; if (open.ShowDialog(this) == true) java.Text = open.FileName; return Task.FromResult(0); })));
            var concurrency = Choice(content, "并行下载文件数", new object[] { 2, 4, 6, 8, 12 }, state.settings.concurrency);
            content.Children.Add(Text("大文件会自动使用最多 4 个分段连接；下载源不支持分段时自动改用普通下载。", 12, "#7D91AB"));
            content.Children.Add(Text("CurseForge API Key", 12, "#68809E"));
            var key = new PasswordBox { Password = state.settings.curseforgeKey ?? "", Padding = new Thickness(10, 8, 10, 8), Margin = new Thickness(0, 0, 0, 17) }; content.Children.Add(key);
            var save = Button("保存设置", async () => {
                int mb; if (!Int32.TryParse(memory.Text.Trim(), out mb)) throw new Exception("内存请输入整数 MB。");
                await client.Request<object>("/settings", new { source = source.SelectedIndex == 0 ? "bmclapi" : "official", memory = mb, javaPath = java.Text.Trim(), concurrency = (int)concurrency.SelectedItem, curseforgeKey = key.Password }, "PATCH");
                await Refresh(); Notify("设置已保存。");
            }, true); System.Windows.Automation.AutomationProperties.SetAutomationId(save, "SaveSettings"); content.Children.Add(Actions(save)); panel.Children.Add(Card(content));
            var storage = new StackPanel(); storage.Children.Add(Text("启动器数据", 19)); var path = Field(storage, "配置与世界目录", state.root); path.IsReadOnly = true;
            storage.Children.Add(Actions(Button("打开数据目录", () => OpenDirectory(state.root)), Button("复制路径", () => { Clipboard.SetText(state.root); Notify("数据目录已复制。"); return Task.FromResult(0); })));
            panel.Children.Add(Card(storage));
        }
        void RenderAccount() {
            var panel = Find<StackPanel>("AccountContent"); panel.Children.Clear(); var content = new StackPanel();
            content.Children.Add(Actions(Button("Microsoft 正版登录", async () => { await CancelLogin(); await client.Request<object>("/settings", new { loginMode = "microsoft" }, "PATCH"); await Refresh(); RenderAccount(); }, state.settings.loginMode == "microsoft"), Button("离线登录", async () => { await CancelLogin(); await client.Request<object>("/settings", new { loginMode = "offline" }, "PATCH"); await Refresh(); RenderAccount(); }, state.settings.loginMode == "offline")));
            if (state.settings.loginMode == "offline") {
                var name = Field(content, "离线玩家名称", state.settings.playerName, "OfflineName"); name.MaxLength = 16;
                content.Children.Add(Text("1–16 位英文字母、数字或下划线。", 11, "#8293AA"));
                var save = Button("保存离线玩家", async () => { await client.Request<object>("/settings", new { playerName = name.Text.Trim(), loginMode = "offline" }, "PATCH"); await Refresh(); Notify("离线玩家已保存。"); }, true);
                System.Windows.Automation.AutomationProperties.SetAutomationId(save, "SaveOffline"); content.Children.Add(Actions(save));
                if (state.account != null) content.Children.Add(Text("已保留 " + state.account.name + " 的正版账户。", 12, "#8293AA"));
            } else {
                if (state.account != null) { content.Children.Add(Text(state.account.name, 22)); content.Children.Add(Text("Microsoft 正版账户已连接", 12, "#6886AC")); }
                if (login != null) {
                    content.Children.Add(Text("在系统浏览器中完成 Microsoft 登录", 18));
                    content.Children.Add(Text("输入验证码并授权后自动绑定。切换页面仍会继续等待。", 12, "#8293AA"));
                    content.Children.Add(Text(login.userCode, 32, "#2874E8")); content.Children.Add(Text(login.verificationUri + " · 有效期约 " + Math.Ceiling(login.expiresIn / 60.0) + " 分钟", 11, "#8293AA"));
                    content.Children.Add(Actions(Button("复制验证码", () => { Clipboard.SetText(login.userCode); Notify("验证码已复制。"); return Task.FromResult(0); }), Button("打开 Microsoft 登录网页", () => { OpenExternal(login.verificationUri); return Task.FromResult(0); }, true), Button("取消登录", async () => { await CancelLogin(); RenderAccount(); })));
                    content.Children.Add(Text("等待 Microsoft 授权…", 12, "#6886AC"));
                } else {
                    var start = Button(state.account == null ? "登录 Microsoft" : "重新登录 Microsoft", async () => await StartLogin(), true); start.IsEnabled = state.microsoftLogin.configured;
                    content.Children.Add(Actions(start));
                    if (!state.microsoftLogin.configured) content.Children.Add(Text("此版本的正版登录服务尚未开通，请联系启动器发布者。", 12, "#C94F57"));
                    if (state.account != null) content.Children.Add(Actions(Button("退出正版账户", async () => { await CancelLogin(); await client.Request<object>("/auth/logout", new {}); await Refresh(); RenderAccount(); Notify("已退出正版账户。"); })));
                }
            }
            if (!String.IsNullOrEmpty(loginError)) content.Children.Add(Text(loginError, 12, "#C94F57")); panel.Children.Add(Card(content));
            if (state.account != null && state.settings.loginMode == "microsoft") RenderAppearance(panel);
        }
        async Task StartLogin() {
            await CancelLogin(); int revision = ++loginRevision; loginError = "";
            var flow = await client.Request<LoginFlow>("/auth/start", new {});
            if (closing || revision != loginRevision) { await client.Request<object>("/auth/cancel", new { flowId = flow.flowId }); return; }
            login = flow; RenderAccount();
            try { OpenExternal(flow.verificationUri); } catch (Exception e) { loginError = "未能自动打开浏览器：" + e.Message; RenderAccount(); }
            PollLogin(flow, revision);
        }
        async Task CancelLogin() {
            loginRevision++; var previous = login; login = null; loginError = "";
            if (previous != null) await client.Request<object>("/auth/cancel", new { flowId = previous.flowId });
        }
        async void PollLogin(LoginFlow flow, int revision) {
            double interval = flow.interval;
            while (!closing && revision == loginRevision && login == flow) {
                await Task.Delay(TimeSpan.FromSeconds(Math.Max(0.3, interval)));
                if (closing || revision != loginRevision || login != flow) return;
                try {
                    var result = await client.Request<LoginPoll>("/auth/poll", new { flowId = flow.flowId });
                    if (closing || revision != loginRevision || login != flow) return;
                    if (result.pending) { if (result.interval > 0) interval = result.interval; continue; }
                    login = null; await Refresh(); if (page == "account") RenderAccount(); Notify("Microsoft 正版账户已自动绑定。"); return;
                } catch (Exception e) { if (closing || revision != loginRevision) return; login = null; loginError = e.Message; if (page == "account") RenderAccount(); Notify(e.Message, true); return; }
            }
        }
        void RenderAppearance(StackPanel panel) {
            var content = new StackPanel(); content.Children.Add(Text("皮肤与披风", 19));
            var variant = Choice(content, "手臂模型", new object[] { "经典（Steve）", "纤细（Alex）" });
            var controls = Actions(Button("获取皮肤与披风", async () => { await client.Request<object>("/auth/appearance", new {}); await Refresh(); if (page == "account") RenderAccount(); }), Button("上传皮肤 PNG", async () => {
                var open = new OpenFileDialog { Title = "选择 Minecraft 皮肤", Filter = "PNG 皮肤|*.png" }; if (open.ShowDialog(this) != true) return;
                if (new FileInfo(open.FileName).Length > 256 * 1024) throw new Exception("皮肤文件最大 256 KB。");
                await client.Request<object>("/auth/skin", new { png = Convert.ToBase64String(File.ReadAllBytes(open.FileName)), variant = variant.SelectedIndex == 0 ? "classic" : "slim" });
                await Refresh(); if (page == "account") RenderAccount(); Notify("皮肤已更换，重新进入游戏后生效。");
            }, true), Button("恢复默认皮肤", async () => { await client.Request<object>("/auth/skin", new { reset = true }); await Refresh(); if (page == "account") RenderAccount(); }));
            content.Children.Add(controls);
            content.Children.Add(Text("支持 64×64 或 64×32 的 PNG，最大 256 KB。", 11, "#8293AA"));
            content.Children.Add(Text("皮肤", 15));
            foreach (var texture in state.account.skins ?? new List<Texture>()) AddTexture(content, texture, "skins", variant);
            if (state.account.skins == null || state.account.skins.Count == 0) content.Children.Add(Text("此账户未返回自定义皮肤。", 12, "#8293AA"));
            content.Children.Add(Text("官方披风", 15));
            foreach (var texture in state.account.capes ?? new List<Texture>()) AddTexture(content, texture, "capes", variant);
            if (state.account.capes == null || state.account.capes.Count == 0) content.Children.Add(Text("此账户暂未拥有官方披风。", 12, "#8293AA"));
            else content.Children.Add(Actions(Button("不使用披风", async () => { await client.Request<object>("/auth/cape", new { capeId = (string)null }); await Refresh(); if (page == "account") RenderAccount(); })));
            if (login != null) { controls.IsEnabled = false; variant.IsEnabled = false; }
            panel.Children.Add(Card(content));
        }
        void AddTexture(StackPanel panel, Texture texture, string kind, ComboBox variant) {
            var content = new StackPanel(); var preview = new Image { Width = 96, Height = 96, HorizontalAlignment = HorizontalAlignment.Left, Stretch = Stretch.Uniform, Margin = new Thickness(0, 0, 0, 10) };
            RenderOptions.SetBitmapScalingMode(preview, BitmapScalingMode.NearestNeighbor); content.Children.Add(preview);
            string label = kind == "skins" ? texture.variant == "slim" ? "纤细手臂皮肤" : "经典手臂皮肤" : texture.name;
            content.Children.Add(Text(label + (texture.active ? " · 使用中" : " · 已拥有"), 12));
            content.Children.Add(Actions(Button("重试预览", async () => await LoadTexture(preview, kind, texture.id)), Button(kind == "skins" ? "使用此皮肤" : "装备披风", async () => {
                await client.Request<object>(kind == "skins" ? "/auth/skin" : "/auth/cape", kind == "skins" ? (object)new { skinId = texture.id, variant = variant.SelectedIndex == 0 ? "classic" : "slim" } : new { capeId = texture.id });
                await Refresh(); if (page == "account") RenderAccount(); Notify("外观已更新。");
            }), Button("保存 PNG", async () => {
                var save = new SaveFileDialog { Title = "保存 Minecraft 外观", Filter = "PNG 图片|*.png", FileName = kind == "skins" ? "skin.png" : "cape.png" };
                if (save.ShowDialog(this) != true) return;
                File.WriteAllBytes(save.FileName, await client.Texture(kind, texture.id)); Notify("PNG 已保存。");
            })));
            if (login != null) content.IsEnabled = false;
            panel.Children.Add(content);
            LoadTexture(preview, kind, texture.id).ContinueWith(task => { if (task.IsFaulted) Dispatch(() => preview.ToolTip = "预览失败，可点击重试预览。"); });
        }
        async Task LoadTexture(Image preview, string kind, string id) {
            byte[] bytes = await client.Texture(kind, id);
            using (var stream = new MemoryStream(bytes)) {
                var bitmap = new BitmapImage(); bitmap.BeginInit(); bitmap.StreamSource = stream; bitmap.CacheOption = BitmapCacheOption.OnLoad; bitmap.EndInit(); bitmap.Freeze(); preview.Source = bitmap;
            }
        }
        Task OpenDirectory(string value) {
            if (String.IsNullOrWhiteSpace(value)) throw new Exception("目录路径为空。");
            string target = Path.GetFullPath(value);
            if (!Directory.Exists(target)) throw new Exception("目录不存在：" + target);
            var start = new ProcessStartInfo(target) { UseShellExecute = true, Verb = "open", WorkingDirectory = target };
            // QA validates the same path and arguments without leaving Explorer windows.
            if (smokeTest) { File.WriteAllText(Path.Combine(dataRoot, "native-qa", "opened-directory.txt"), target); return Task.FromResult(0); }
            using (var process = Process.Start(start)) { }
            Notify("已打开目录。"); return Task.FromResult(0);
        }
        void OpenExternal(string value) {
            Uri uri; if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || uri.Scheme != "https") throw new Exception("仅支持 HTTPS 外部链接。");
            if (smokeTest) return;
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
    }
}
