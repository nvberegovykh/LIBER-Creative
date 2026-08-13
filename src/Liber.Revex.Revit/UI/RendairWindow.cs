using Autodesk.Revit.UI;
using Liber.Revex.Revit.Models;
using Liber.Revex.Revit.Revit;
using Liber.Revex.Revit.Services;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Win32;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using WpfTextBox = System.Windows.Controls.TextBox;
using WpfComboBox = System.Windows.Controls.ComboBox;
using System.Windows.Media;
using System.IO;
using System.Text.Json;

namespace Liber.Revex.Revit.UI;

public sealed class RendairWindow : Window
{
    private readonly RevitRequestHandler _handler;
    private readonly ExternalEvent _externalEvent;
    private readonly BridgeSettings _bridgeSettings;

    private readonly WebView2 _web = new();
    private readonly TextBlock _status = new();
    private readonly WpfTextBox _prompt = new();
    private readonly WpfTextBox _batchToken = new();
    private readonly WpfTextBox _projectId = new();
    private readonly WpfTextBox _engineeringProjectId = new();
    private readonly WpfTextBox _specProjectId = new();
    private readonly WpfComboBox _environment = new();
    private readonly WpfComboBox _staging = new();
    private readonly WpfComboBox _people = new();
    private readonly CheckBox _autoMaterials = new();
    private readonly ListBox _queue = new();
    private readonly WpfTextBox _diagnostics = new();
    private readonly StackPanel _designControls = new();
    private readonly StackPanel _engineeringControls = new();
    private readonly Button _designMode = new();
    private readonly Button _engineeringMode = new();
    private readonly WpfTextBox _gbxmlOutput = new();
    private readonly WpfTextBox _gbxmlName = new();
    private readonly WpfTextBox _gbxmlPhase = new();
    private readonly WpfTextBox _gbxmlMiniLm = new();
    private readonly WpfTextBox _energyWeather = new();
    private string _resolvedEnergyWeatherPath = "";
    private readonly CheckBox _gbxmlAudit = new();
    private readonly CheckBox _gbxmlFix = new();
    private readonly CheckBox _gbxmlForce = new();
    private readonly TextBlock _gbxmlLastResult = new();
    private ColumnDefinition? _controlsColumn;

    private readonly List<TransferPackage> _packages = new();
    private readonly List<CoreWebView2Frame> _renderFrames = new();
    private int _selectedPackageIndex = -1;
    private RevexSyncOutput? _pendingSync;
    private EngineeringSyncOutput? _pendingEngineeringSync;
    private EngineeringSyncOutput? _lastEngineeringSync;
    private EnergyPipelineOutput? _pendingEnergyResult;
    private string? _lastSyncFolder;
    private TransferPackage? _pendingQuickRender;
    private string _pendingQuickPrompt = "";
    private string _pendingRenderJobId = "";
    private bool _syncAwaitingRevit;
    private bool _renderAwaitingRevit;
    private bool _gbxmlAwaitingRevit;
    private bool _energySyncRequested;
    private bool _energyPipelineRunning;
    private bool _explicitProjectSelectionPending;
    private bool _applyingResolvedProjectBinding;
    private bool _engineeringModeActive;
    private bool _energySyncWaitingForProject;
    private string _activeGbxmlCorrelationId = "";
    private string _activeGbxmlInitiator = "";
    private string? _lastGbxmlFolder;
    private string _activeProjectName = "";
    private int _webRendererUnresponsiveCount;
    private DateTime _webRendererUnresponsiveWindow = DateTime.MinValue;
    private bool _webRecoveryPending;
    private bool _projectBindingProbePending;

    public RendairWindow(RevitRequestHandler handler, ExternalEvent externalEvent)
    {
        _handler = handler;
        _externalEvent = externalEvent;
        _bridgeSettings = SettingsService.Load();

        Title = "LIBER REVEX";
        Width = 1780;
        Height = 930;
        MinWidth = 1280;
        MinHeight = 720;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;

        Content = BuildLayout();

        RevexDiagnostics.Line += OnDiagnosticLine;
        Closed += (_, _) => RevexDiagnostics.Line -= OnDiagnosticLine;
        string runtimeVersion = typeof(RendairWindow).Assembly.GetName().Version?.ToString(3) ?? "unknown";
        RevexDiagnostics.Info("UI", $"REVEX {runtimeVersion} window constructed.");
        Loaded += async (_, _) =>
        {
            await InitializeBrowserAsync();
            ResolveActiveDocumentProjectBinding();
        };
    }

    private UIElement BuildLayout()
    {
        var root = new Grid();
        _controlsColumn = new ColumnDefinition { Width = new GridLength(390) };
        root.ColumnDefinitions.Add(_controlsColumn);
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(370) });

        var leftScroll = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Padding = new Thickness(16)
        };

        var left = new StackPanel();
        leftScroll.Content = left;

        var title = new TextBlock
        {
            Text = "LIBER REVEX",
            FontSize = 22,
            FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(0, 0, 0, 4)
        };
        left.Children.Add(title);

        left.Children.Add(new TextBlock
        {
            Text = "One REVEX interface for design and engineering. Revit stays authoritative; each mode exposes only the controls needed for the current task.",
            TextWrapping = TextWrapping.Wrap,
            Opacity = 0.75,
            Margin = new Thickness(0, 0, 0, 18)
        });

        var modeSwitch = new Grid { Margin = new Thickness(0, 0, 0, 10) };
        modeSwitch.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        modeSwitch.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        ConfigureModeButton(_designMode, "DESIGN", (_, _) => SetMode(false));
        ConfigureModeButton(_engineeringMode, "ENGINEERING", (_, _) => SetMode(true));
        modeSwitch.Children.Add(_designMode);
        Grid.SetColumn(_engineeringMode, 1);
        modeSwitch.Children.Add(_engineeringMode);
        left.Children.Add(modeSwitch);

        left.Children.Add(_designControls);
        left.Children.Add(_engineeringControls);
        _engineeringControls.Visibility = Visibility.Collapsed;

        _designControls.Children.Add(SectionTitle("PROJECT"));
        // A process-wide last-used project is not evidence for the active Revit
        // document. The external-event probe below supplies only that document's
        // verified binding, or leaves this blank for one explicit selection.
        _projectId.Text = "";
        _engineeringProjectId.Text = _projectId.Text;
        _engineeringProjectId.IsReadOnly = true;
        _engineeringProjectId.IsTabStop = false;
        _projectId.TextChanged += (_, _) =>
        {
            if (!string.Equals(_engineeringProjectId.Text, _projectId.Text, StringComparison.Ordinal))
                _engineeringProjectId.Text = _projectId.Text;
            if (!_applyingResolvedProjectBinding)
            {
                _activeProjectName = "";
                _explicitProjectSelectionPending = true;
                _specProjectId.Text = SettingsService.ExpectedSpecProjectId(_projectId.Text.Trim());
                RevexDiagnostics.Info("PROJECT", "Manual project ID edit armed one explicit active-document binding.");
            }
        };
        _specProjectId.Text = _bridgeSettings.LiberSpecProjectId ?? "";
        _designControls.Children.Add(LabeledInput("LIBER Project ID", _projectId, "Create or select the project in REVEX Companion; the ID returns here automatically"));
        _designControls.Children.Add(MakeButton("SYNC BIM + BOOKS", (_, _) => SyncRevexProject()));
        _designControls.Children.Add(new TextBlock
        {
            Text = "One click exports immutable IFC + browser display geometry + BIM metadata + Design Book sources + every remaining Spec Book schedule, then publishes one controlled REVEX revision. No RVT parameters are written.",
            TextWrapping = TextWrapping.Wrap,
            FontSize = 11,
            Opacity = 0.68,
            Margin = new Thickness(0, 1, 0, 8)
        });
        _designControls.Children.Add(MakeButton("OPEN SYNC FOLDER", (_, _) => OpenSyncFolder(), secondary: true));
        _designControls.Children.Add(MakeButton("RETRY LAST PUBLISH", (_, _) => RetryLastPublish(), secondary: true));

        _designControls.Children.Add(SectionTitle("RENDER CURRENT VIEW"));
        _prompt.AcceptsReturn = false;
        _prompt.TextWrapping = TextWrapping.NoWrap;
        _prompt.Height = 34;
        _prompt.Margin = new Thickness(0, 0, 0, 6);
        _prompt.ToolTip = "Tell WALLT what you want. REVEX adds the current Revit view, material intent and geometry-preservation constraints automatically.";
        _prompt.KeyDown += (_, e) =>
        {
            if (e.Key != System.Windows.Input.Key.Enter) return;
            e.Handled = true;
            QuickRenderCurrentView();
        };
        _designControls.Children.Add(_prompt);
        _designControls.Children.Add(MakeButton("RENDER CURRENT VIEW", (_, _) => QuickRenderCurrentView()));
        _designControls.Children.Add(new TextBlock
        {
            Text = "One line is enough. REVEX captures the active Revit 3D viewport, opens Rendair in this window, attaches the capture, adds Revit context, and starts the render.",
            TextWrapping = TextWrapping.Wrap,
            FontSize = 11,
            Opacity = 0.68,
            Margin = new Thickness(0, 1, 0, 8)
        });
        _designControls.Children.Add(MakeButton("OPEN RENDAIR", (_, _) => OpenRenderBridge(), secondary: true));

        BuildEngineeringControls();
        SetMode(false);

        // Advanced render settings remain available to the agent but are intentionally
        // not exposed as a second manual workflow. The default path is one prompt + Enter.
        _batchToken.Text = _bridgeSettings.BatchViewNameContains;
        _autoMaterials.IsChecked = true;
        PopulateCombo(_environment, new[] { "Natural daylight", "Bright overcast", "Warm late-afternoon daylight", "Night exterior - physically plausible" }, 0);
        PopulateCombo(_staging, new[] { "Preserve modeled objects only", "Minimal real-estate staging", "No loose furniture" }, 0);
        PopulateCombo(_people, new[] { "None", "Very sparse, natural scale" }, 0);

        _status.TextWrapping = TextWrapping.Wrap;
        _status.Margin = new Thickness(0, 18, 0, 4);
        _status.Opacity = 0.78;
        left.Children.Add(_status);

        Grid.SetColumn(leftScroll, 0);
        root.Children.Add(leftScroll);

        var webRoot = new Grid();
        webRoot.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        webRoot.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        var nav = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Margin = new Thickness(8)
        };
        nav.Children.Add(MakeNavButton("←", (_, _) => { if (_web.CanGoBack) _web.GoBack(); }));
        nav.Children.Add(MakeNavButton("→", (_, _) => { if (_web.CanGoForward) _web.GoForward(); }));
        nav.Children.Add(MakeNavButton("↻", (_, _) => _web.Reload()));
        nav.Children.Add(MakeNavButton("BIM", (_, _) => OpenCompanion("bim")));
        nav.Children.Add(MakeNavButton("Design Book", (_, _) => OpenCompanion("design")));
        nav.Children.Add(MakeNavButton("Spec Book", (_, _) => OpenCompanion("spec")));
        nav.Children.Add(MakeNavButton("Docs", (_, _) => OpenCompanion("docs")));
        nav.Children.Add(MakeNavButton("Energy", (_, _) => OpenCompanion("energy")));
        nav.Children.Add(MakeNavButton("Chat", (_, _) => OpenCompanion("chat")));
        nav.Children.Add(MakeNavButton("Render", (_, _) => OpenRenderBridge()));
        nav.Children.Add(MakeNavButton("LIBER Account", (_, _) => _web.Source = new Uri(_bridgeSettings.LiberAppsUrl)));

        webRoot.Children.Add(nav);

        Grid.SetRow(_web, 1);
        webRoot.Children.Add(_web);

        Grid.SetColumn(webRoot, 1);
        root.Children.Add(webRoot);

        UIElement diagnostics = BuildDiagnosticsPanel();
        Grid.SetColumn(diagnostics, 2);
        root.Children.Add(diagnostics);

        return root;
    }

    private void BuildEngineeringControls()
    {
        _engineeringControls.Children.Clear();

        // Production Engineering UI mirrors the current Companion Energy contract:
        // Revit evidence is automatic; weather is the only user-selected energy input.
        _gbxmlAudit.IsChecked = false;
        _gbxmlFix.IsChecked = true;
        _gbxmlForce.IsChecked = false;

        _engineeringControls.Children.Add(SectionTitle("PROJECT"));
        _engineeringControls.Children.Add(LabeledInput(
            "LIBER Project ID",
            _engineeringProjectId,
            "Same authoritative REVEX Project ID used by BIM, Design Book, Spec Book and Energy. It is recovered from the Companion selection or URL during cloud/auth hydration and is never silently cleared."));
        _engineeringControls.Children.Add(MakeButton("OPEN / SELECT PROJECT", (_, _) => OpenCompanion("energy"), secondary: true));

        _engineeringControls.Children.Add(SectionTitle("ENGINEERING / ENERGY SYNC"));
        _engineeringControls.Children.Add(new TextBlock
        {
            Text = "One controlled chain. REVEX prepares Revit evidence, blocks publication below 80%, preserves sub-80% evidence for repair, and flags any published result below 95% for review in Companion.",
            TextWrapping = TextWrapping.Wrap,
            FontSize = 11,
            Opacity = 0.72,
            Margin = new Thickness(0, 0, 0, 8)
        });

        _engineeringControls.Children.Add(EngineeringInfoCard(
            "01 · REVIT EVIDENCE",
            "Spaces + analytical model + EN/Energy tags",
            "Phase, evidence folder and gbXML naming are resolved automatically. REVEX preserves Revit as the authority and publishes only when every required evidence domain reaches the ≥80% hard-stop gate; results from 80% to below 95% continue with an explicit Companion quality warning, and anything below 80% is preserved for repair."));

        _energyWeather.ToolTip = "Select the EnergyPlus weather file used for this Energy revision. The selected .EPW remains changeable until SYNC ENGINEERING starts, then it is copied and hashed into the immutable revision.";
        _engineeringControls.Children.Add(SectionTitle("02 · WEATHER"));
        _engineeringControls.Children.Add(LabeledInput(
            "Weather file (.EPW)",
            _energyWeather,
            "Select or change the project weather file. Blank is allowed only when REVEX can resolve exactly one valid project EPW; ambiguous weather is never guessed."));
        _engineeringControls.Children.Add(MakeButton("SELECT / CHANGE WEATHER FILE", (_, _) => SelectEnergyWeather(), secondary: true));

        _engineeringControls.Children.Add(EngineeringInfoCard(
            "03 · CONTROLLED PROCESSING",
            "GeometryCo → Baseline + Proposed → EnergyPlus → EN-1",
            "After the ≥80% Revit hard-stop gate, the managed server runs the deterministic downstream chain. Results below 95% remain explicit review-quality evidence in Companion; sub-80% evidence never publishes. Applicant/modeler/signature/seal remain blank and there is no writeback to Revit."));

        _engineeringControls.Children.Add(MakeButton("SYNC ENGINEERING", async (_, _) => await RunEnergySyncToCompanionAsync()));
        _engineeringControls.Children.Add(MakeButton("OPEN EVIDENCE FOLDER", (_, _) => OpenGbxmlFolder(), secondary: true));

        _gbxmlLastResult.TextWrapping = TextWrapping.Wrap;
        _gbxmlLastResult.FontSize = 10.5;
        _gbxmlLastResult.Opacity = 0.72;
        _gbxmlLastResult.Margin = new Thickness(0, 10, 0, 0);
        _engineeringControls.Children.Add(_gbxmlLastResult);
    }

    private static void ConfigureModeButton(Button button, string text, RoutedEventHandler handler)
    {
        button.Content = text;
        button.Height = 32;
        button.Margin = new Thickness(2);
        button.Click += handler;
    }

    private void SetMode(bool engineering)
    {
        _engineeringModeActive = engineering;
        _designControls.Visibility = engineering ? Visibility.Collapsed : Visibility.Visible;
        _engineeringControls.Visibility = engineering ? Visibility.Visible : Visibility.Collapsed;
        _designMode.FontWeight = engineering ? FontWeights.Normal : FontWeights.Bold;
        _engineeringMode.FontWeight = engineering ? FontWeights.Bold : FontWeights.Normal;
        _designMode.Opacity = engineering ? 0.62 : 1.0;
        _engineeringMode.Opacity = engineering ? 1.0 : 0.62;
        RevexDiagnostics.Info("UI", engineering ? "Engineering mode active." : "Design mode active.");
    }

    private UIElement BuildDiagnosticsPanel()
    {
        var panel = new Grid
        {
            Background = new SolidColorBrush(Color.FromRgb(15, 18, 24))
        };
        panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        panel.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        var header = new DockPanel { Margin = new Thickness(10, 10, 10, 6) };
        var title = new TextBlock
        {
            Text = "DIAGNOSTICS",
            FontWeight = FontWeights.Bold,
            VerticalAlignment = VerticalAlignment.Center
        };
        DockPanel.SetDock(title, Dock.Left);
        header.Children.Add(title);

        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        var copy = MakeNavButton("COPY", (_, _) => CopyDiagnostics());
        copy.MinWidth = 62;
        var clear = MakeNavButton("CLEAR", (_, _) => _diagnostics.Clear());
        clear.MinWidth = 62;
        buttons.Children.Add(copy);
        buttons.Children.Add(clear);
        DockPanel.SetDock(buttons, Dock.Right);
        header.Children.Add(buttons);
        panel.Children.Add(header);

        var path = new TextBlock
        {
            Text = "Session log: " + RevexDiagnostics.SessionLogPath,
            FontSize = 9,
            Opacity = 0.55,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(10, 0, 10, 7)
        };
        Grid.SetRow(path, 1);
        panel.Children.Add(path);

        _diagnostics.IsReadOnly = true;
        _diagnostics.AcceptsReturn = true;
        _diagnostics.AcceptsTab = true;
        _diagnostics.TextWrapping = TextWrapping.NoWrap;
        _diagnostics.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        _diagnostics.HorizontalScrollBarVisibility = ScrollBarVisibility.Auto;
        _diagnostics.FontFamily = new FontFamily("Consolas");
        _diagnostics.FontSize = 10.5;
        _diagnostics.Background = new SolidColorBrush(Color.FromRgb(8, 10, 14));
        _diagnostics.Foreground = new SolidColorBrush(Color.FromRgb(211, 218, 230));
        _diagnostics.BorderThickness = new Thickness(0);
        _diagnostics.Padding = new Thickness(8);
        _diagnostics.Text = RevexDiagnostics.Snapshot();
        Grid.SetRow(_diagnostics, 2);
        panel.Children.Add(_diagnostics);

        return panel;
    }

    private void CopyDiagnostics()
    {
        try
        {
            Clipboard.SetText(_diagnostics.Text ?? string.Empty);
            RevexDiagnostics.Info("UI", "Diagnostics copied to clipboard.");
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("UI", "Could not copy diagnostics.", ex);
        }
    }

    private void OnDiagnosticLine(string line)
    {
        if (Dispatcher.HasShutdownStarted) return;
        Dispatcher.BeginInvoke(new Action(() =>
        {
            _diagnostics.AppendText(line + Environment.NewLine);
            _diagnostics.ScrollToEnd();
        }));
    }

    private async Task InitializeBrowserAsync()
    {
        RevexDiagnostics.Info("WEB", "Initializing WebView2 environment.");
        try
        {
            AppPaths.Ensure();
            var env = await CoreWebView2Environment.CreateAsync(userDataFolder: AppPaths.WebProfile);
            await _web.EnsureCoreWebView2Async(env);
            RevexDiagnostics.Info("WEB", "WebView2 core initialized. Profile=" + AppPaths.WebProfile);

            // Keep login/cookies/session storage, but never let an old hosted REVEX JS bundle
            // survive a product update in the embedded browser.
            try
            {
                await _web.CoreWebView2.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.DiskCache);
            }
            catch
            {
                // Cache clearing is freshness hardening only; browser startup must remain usable.
            }

            _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            _web.CoreWebView2.Settings.IsStatusBarEnabled = false;

            _web.CoreWebView2.NavigationStarting += (_, e) =>
                RevexDiagnostics.Info("WEB", "NAV START " + (e.Uri ?? ""));
            _web.CoreWebView2.ProcessFailed += (_, e) =>
            {
                RevexDiagnostics.Error("WEB", "WebView2 process failed: " + e.ProcessFailedKind);
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                {
                    var now = DateTime.UtcNow;
                    if ((now - _webRendererUnresponsiveWindow).TotalSeconds > 12)
                        _webRendererUnresponsiveCount = 0;
                    _webRendererUnresponsiveWindow = now;
                    _webRendererUnresponsiveCount++;
                    // WebView2 may raise this repeatedly while a long-running renderer task is stuck.
                    // One event is allowed to recover naturally; a repeated event reloads the same URL.
                    if (_webRendererUnresponsiveCount >= 2 && !_webRecoveryPending)
                    {
                        _webRecoveryPending = true;
                        Dispatcher.BeginInvoke(new Action(() =>
                        {
                            try
                            {
                                RevexDiagnostics.Warn("WEB", "Renderer remained unresponsive; reloading REVEX shell at the current project URL.");
                                _web.Reload();
                            }
                            catch (Exception ex)
                            {
                                RevexDiagnostics.Error("WEB", "WebView2 recovery reload failed.", ex);
                            }
                        }));
                    }
                }
                else if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited && !_webRecoveryPending)
                {
                    _webRecoveryPending = true;
                    Dispatcher.BeginInvoke(new Action(() =>
                    {
                        try { _web.Reload(); }
                        catch (Exception ex) { RevexDiagnostics.Error("WEB", "WebView2 renderer-exit reload failed.", ex); }
                    }));
                }
            };

            _web.CoreWebView2.NewWindowRequested += async (_, e) =>
            {
                RevexDiagnostics.Info("WEB", "NEW WINDOW " + (e.Uri ?? ""));
                e.Handled = true;
                if (!string.IsNullOrWhiteSpace(e.Uri))
                {
                    string target = JsonSerializer.Serialize(e.Uri);
                    string embedded = await _web.ExecuteScriptAsync($$"""
                    (() => {
                      const frame = document.getElementById('render-frame');
                      if (frame) { frame.src = {{target}}; return true; }
                      return false;
                    })();
                    """);
                    if (!string.Equals(embedded, "true", StringComparison.OrdinalIgnoreCase))
                        _web.Source = new Uri(e.Uri);
                }
            };

            _web.CoreWebView2.NavigationCompleted += async (_, e) =>
            {
                _webRendererUnresponsiveCount = 0;
                _webRecoveryPending = false;
                RevexDiagnostics.Info("WEB", $"NAV END id={e.NavigationId} success={e.IsSuccess} status={e.WebErrorStatus} current={_web.Source}");
                await HandleNavigationCompletedAsync(e.NavigationId, e.IsSuccess, e.WebErrorStatus);
            };
            _web.CoreWebView2.WebMessageReceived += (_, e) =>
            {
                string payload = e.WebMessageAsJson ?? "";
                RevexDiagnostics.Info("WEBMSG", payload.Length <= 500 ? payload : payload[..500] + "…");
                HandleCompanionMessage(payload);
            };
            _web.CoreWebView2.FrameCreated += (_, e) =>
            {
                RevexDiagnostics.Info("WEB", "Frame created.");
                TrackRenderFrame(e.Frame);
            };

            _web.Source = new Uri(_bridgeSettings.LiberAppsUrl);
            SetStatus("REVEX ready. LIBER and Rendair sessions persist in the local WebView2 profile.");
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("WEB", "Web mirror failed to initialize.", ex);
            SetStatus("Web mirror failed to initialize: " + ex.Message);
        }
    }

    private void SyncRevexProject()
    {
        if (_syncAwaitingRevit)
        {
            SetStatus("A REVEX source revision is already being prepared for the active document.");
            return;
        }
        RevexDiagnostics.Info("SYNC", "SYNC BIM + BOOKS clicked. Project=" + _projectId.Text.Trim());
        if (string.IsNullOrWhiteSpace(_projectId.Text))
        {
            SetStatus("Choose the REVEX project in the Companion first. Its Project ID will appear here automatically.");
            _projectId.Focus();
            RevexDiagnostics.Error("SYNC", "No REVEX Project ID is available after probing the Companion.");
            return;
        }

        SaveBridgeSettings();
        _syncAwaitingRevit = true;
        _ = WatchPendingAsync("SYNC", () => _syncAwaitingRevit);
        SetStatus("Synchronizing REVEX BIM, Design Book and specification source...");
        _handler.Enqueue(new RevitRequest(
            RevitRequestKind.SyncRevexProject,
            CurrentSettings(),
            result => Dispatcher.BeginInvoke(new Action(() => HandleSyncResult(result))))
        {
            CorrelationId = RevexDiagnostics.NewCorrelationId("sync"),
            Initiator = "SYNC BIM + BOOKS button",
            ProjectBindingCandidate = CurrentProjectBindingCandidate(),
            AllowProjectRebind = _explicitProjectSelectionPending
        });
        _explicitProjectSelectionPending = false;

        _externalEvent.Raise();
        RevexDiagnostics.Info("SYNC", "Revit ExternalEvent raised; waiting for Revit callback.");
    }

    private void ResolveActiveDocumentProjectBinding()
    {
        if (_projectBindingProbePending) return;
        _projectBindingProbePending = true;
        string correlationId = RevexDiagnostics.NewCorrelationId("project-probe");
        RevexDiagnostics.Info("PROJECT", "Resolving the active Revit document binding before Companion activation.");
        _handler.Enqueue(new RevitRequest(
            RevitRequestKind.ResolveActiveProjectBinding,
            CurrentSettings(),
            result => Dispatcher.BeginInvoke(new Action(() =>
            {
                _projectBindingProbePending = false;
                if (result.Success && result.ProjectBinding != null)
                {
                    ApplyResolvedProjectBinding(result.ProjectBinding);
                    _explicitProjectSelectionPending = false;
                    _ = PersistProjectBindingIntoCompanionAsync(
                        result.ProjectBinding.ProjectId,
                        result.ProjectBinding.SpecProjectId,
                        result.ProjectBinding.ProjectName);
                    OpenCompanion("bim");
                    SetStatus("Active Revit model connected to " + result.ProjectBinding.ProjectId + ".");
                    return;
                }

                _applyingResolvedProjectBinding = true;
                try
                {
                    _projectId.Text = "";
                    _engineeringProjectId.Text = "";
                    _specProjectId.Text = "";
                }
                finally { _applyingResolvedProjectBinding = false; }
                _explicitProjectSelectionPending = false;
                SetStatus("This active Revit model needs one explicit REVEX project selection. No other open model or prior revision was used.");
                RevexDiagnostics.Warn("PROJECT", "Active-document binding probe requires explicit selection: " + result.Message);
            })))
        {
            CorrelationId = correlationId,
            Initiator = "REVEX window active-document binding probe",
            ProjectBindingCandidate = null,
            AllowProjectRebind = false
        });
        _externalEvent.Raise();
    }

    public void NotifyActiveDocumentChanged()
    {
        Dispatcher.BeginInvoke(new Action(() =>
        {
            _applyingResolvedProjectBinding = true;
            try
            {
                _projectId.Text = "";
                _engineeringProjectId.Text = "";
                _specProjectId.Text = "";
                _activeProjectName = "";
            }
            finally { _applyingResolvedProjectBinding = false; }
            _explicitProjectSelectionPending = false;
            SetStatus("Active Revit document changed. Resolving its own REVEX project binding…");
            ResolveActiveDocumentProjectBinding();
        }));
    }

    private void HandleSyncResult(RevitRequestResult result)
    {
        _syncAwaitingRevit = false;
        ApplyResolvedProjectBinding(result.ProjectBinding);
        RevexDiagnostics.Info("SYNC", $"Revit callback received. success={result.Success} message={result.Message}");
        if (!result.Success || result.SyncOutput == null)
        {
            ShowFailure("SYNC BIM + BOOKS failed", result.Message);
            return;
        }

        SetStatus(result.Message + " No model parameters were written.");
        _pendingSync = result.SyncOutput;
        _lastSyncFolder = result.SyncOutput.RootFolder;
        RevexDiagnostics.Info("SYNC", "Local revision ready: " + _lastSyncFolder);
        OpenCompanion("bim");
    }

    private void OpenCompanion(string mode)
    {
        _ = OpenCompanionAsync(mode);
    }

    private async Task OpenCompanionAsync(string mode)
    {
        RevexDiagnostics.Info("COMPANION", "Opening mode=" + mode + " project=" + _projectId.Text.Trim());
        try
        {
            if (_controlsColumn != null) _controlsColumn.Width = new GridLength(390);
            if (_web.CoreWebView2 == null)
            {
                SetStatus("REVEX browser is still initializing.");
                return;
            }

            SaveBridgeSettings();
            string projectId = _projectId.Text.Trim();
            string specProjectId = _specProjectId.Text.Trim();

            // Do not reload the authenticated Companion shell merely to change the
            // visible REVEX section. Re-navigation was resetting the hosted r26/r27
            // scripts, briefly downgrading auth to local mode and re-installing the
            // retired Energy handler while an Engineering revision was being attached.
            Uri? current = _web.Source;
            bool currentRevex = current != null &&
                current.AbsoluteUri.Contains("/apps/revex/", StringComparison.OrdinalIgnoreCase);
            if (currentRevex && !string.IsNullOrWhiteSpace(projectId))
            {
                string modeJson = JsonSerializer.Serialize(mode);
                string projectJson = JsonSerializer.Serialize(projectId);
                string specJson = JsonSerializer.Serialize(specProjectId);
                // Three interpolation delimiters leave JavaScript's adjacent `}}`
                // object closers as literal content. With `$$"""`, Roslyn treats
                // that valid JavaScript brace run as C# interpolation syntax.
                string activated = await _web.ExecuteScriptAsync($$$"""
                    (() => {
                      const expectedProject = {{{projectJson}}};
                      if (!expectedProject) return false;
                      const mode = {{{modeJson}}};
                      window.dispatchEvent(new CustomEvent('revex:native-project-binding',{detail:{projectId:expectedProject,specProjectId:{{{specJson}}},view:mode}}));
                      const button = document.querySelector(`[data-view="${mode}"]`);
                      if (button) button.click();
                      try {
                        const params = new URLSearchParams(location.search);
                        params.set('build', '20260813r49');
                        params.set('projectId', expectedProject);
                        if ({{{specJson}}}) params.set('specProjectId', {{{specJson}}});
                        if (mode) params.set('view', mode);
                        history.replaceState(history.state, '', `${location.pathname}?${params.toString()}`);
                      } catch (_) {}
                      return true;
                    })()
                    """);
                if (string.Equals(activated, "true", StringComparison.OrdinalIgnoreCase))
                {
                    RevexDiagnostics.Info("COMPANION", "Activated mode in-place without reloading authenticated Companion.");
                    await InstallNativeProjectSelectionBridgeAsync();
                    await EngineeringCompanionWebBridge.EnsureManagedEnergyBridgeAsync(_web);
                    await ApplyEnergyCompanionNativePolicyAsync();
                    return;
                }
            }

            string separator = _bridgeSettings.LiberRevexUrl.Contains('?') ? "&" : "?";
            string url = _bridgeSettings.LiberRevexUrl + separator +
                         "build=20260813r49" +
                         "&fresh=" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString() +
                         "&projectId=" + Uri.EscapeDataString(projectId) +
                         "&view=" + Uri.EscapeDataString(mode);
            if (!string.IsNullOrWhiteSpace(specProjectId))
                url += "&specProjectId=" + Uri.EscapeDataString(specProjectId);
            _web.Source = new Uri(url);
        }
        catch (Exception ex)
        {
            SetStatus("Could not open REVEX companion: " + ex.Message);
        }
    }

    private async Task PublishPendingEngineeringSyncAsync()
    {
        EngineeringSyncOutput? pending = _pendingEngineeringSync;
        if (pending == null) return;

        Uri? current = _web.Source;
        bool onRevex = current != null &&
            current.AbsoluteUri.Contains("/apps/revex/", StringComparison.OrdinalIgnoreCase);
        if (!onRevex)
        {
            OpenCompanion("energy");
            return;
        }

        var bridge = await EngineeringCompanionWebBridge.EnsureManagedEnergyBridgeAsync(_web);
        if (!bridge.ok)
        {
            RevexDiagnostics.Warn("ENERGY-SYNC", bridge.message);
            OpenCompanion("energy");
            return;
        }

        await ApplyEnergyCompanionNativePolicyAsync();
        var attached = await EngineeringCompanionWebBridge.AttachEngineeringSyncAsync(_web, pending);
        SetStatus(attached.message);
        if (!attached.ok)
        {
            RevexDiagnostics.Warn("ENERGY-SYNC", "Managed-server handoff could not start in-place: " + attached.message);
            OpenCompanion("energy");
        }
    }

    private void RetryLastPublish()
    {
        try
        {
            AppPaths.Ensure();
            string activeProjectId = _projectId.Text.Trim();
            string? folder = _lastSyncFolder;
            if (!string.IsNullOrWhiteSpace(folder) &&
                (!Directory.Exists(folder) || !RevisionMatchesProject(folder, activeProjectId)))
                folder = null;
            if (string.IsNullOrWhiteSpace(folder) || !Directory.Exists(folder))
            {
                folder = Directory.GetDirectories(AppPaths.SyncRevisions, "rev_*", SearchOption.TopDirectoryOnly)
                    .OrderByDescending(Directory.GetLastWriteTimeUtc)
                    .FirstOrDefault(path => RevisionMatchesProject(path, activeProjectId));
            }
            if (string.IsNullOrWhiteSpace(folder) || !Directory.Exists(folder))
            {
                SetStatus("No preserved REVEX revision is available to retry.");
                RevexDiagnostics.Warn("SYNC", "Retry publish requested but no revision exists for the active project: " + activeProjectId);
                return;
            }

            string project = Path.Combine(folder, "project.json");
            string design = Path.Combine(folder, "design-book.json");
            string spec = Path.Combine(folder, "spec-revit-push.json");
            string viewer = Path.Combine(folder, "viewer-model.json");
            string integrity = Path.Combine(folder, "integrity.json");
            string? ifc = Directory.GetFiles(folder, "*.ifc", SearchOption.TopDirectoryOnly).FirstOrDefault();
            string? fbx = Directory.GetFiles(folder, "*.fbx", SearchOption.TopDirectoryOnly).FirstOrDefault();
            string? mesh = Directory.GetFiles(folder, "*.rvxmesh.gz", SearchOption.TopDirectoryOnly).FirstOrDefault();
            string? meshManifest = Directory.GetFiles(folder, "model.rvxpages.json", SearchOption.AllDirectories).FirstOrDefault();
            string[] meshPages = Directory.GetFiles(folder, "*.rvxmesh.gz", SearchOption.AllDirectories)
                .Where(path => !string.Equals(path, mesh, StringComparison.OrdinalIgnoreCase))
                .OrderBy(path => path, StringComparer.OrdinalIgnoreCase).ToArray();
            string printing = Path.Combine(folder, "printing-sets.json");
            string[] printingPdfs = Directory.Exists(Path.Combine(folder, "printing-sets"))
                ? Directory.GetFiles(Path.Combine(folder, "printing-sets"), "*.pdf", SearchOption.TopDirectoryOnly)
                : Array.Empty<string>();
            string affectedPlans = Path.Combine(folder, "affected-plan-views.json");
            string[] affectedPlanPdfs = Directory.Exists(Path.Combine(folder, "affected-plans"))
                ? Directory.GetFiles(Path.Combine(folder, "affected-plans"), "*.pdf", SearchOption.TopDirectoryOnly)
                : Array.Empty<string>();
            string[] required = { project, design, spec, viewer, integrity };
            if (required.Any(path => !File.Exists(path)) || string.IsNullOrWhiteSpace(ifc) || !File.Exists(ifc))
            {
                SetStatus("The preserved revision is incomplete and cannot be republished.");
                RevexDiagnostics.Error("SYNC", "Retry publish revision is incomplete: " + folder);
                return;
            }

            string revision = Path.GetFileName(folder);
            int schedules = 0, elements = 0, printingSets = 0, printingSheets = 0, affectedPlanViews = 0, changedElements = 0;
            try
            {
                using JsonDocument manifest = JsonDocument.Parse(File.ReadAllText(integrity));
                JsonElement root = manifest.RootElement;
                if (root.TryGetProperty("revision", out JsonElement rev)) revision = rev.GetString() ?? revision;
                if (root.TryGetProperty("counts", out JsonElement counts))
                {
                    if (counts.TryGetProperty("schedules", out JsonElement sc)) schedules = sc.GetInt32();
                    if (counts.TryGetProperty("elements", out JsonElement ec)) elements = ec.GetInt32();
                    if (counts.TryGetProperty("printingSets", out JsonElement pc)) printingSets = pc.GetInt32();
                    if (counts.TryGetProperty("printingSheets", out JsonElement psc)) printingSheets = psc.GetInt32();
                    if (counts.TryGetProperty("affectedPlanViews", out JsonElement apv)) affectedPlanViews = apv.GetInt32();
                    if (counts.TryGetProperty("changedElements", out JsonElement ce)) changedElements = ce.GetInt32();
                }
            }
            catch (Exception ex)
            {
                RevexDiagnostics.Warn("SYNC", "Retry manifest summary could not be read: " + ex.Message);
            }

            if (!File.Exists(affectedPlans))
            {
                try
                {
                    File.WriteAllText(affectedPlans, JsonSerializer.Serialize(new
                    {
                        schema = "liber.revex.affected-plan-views.v1",
                        revision,
                        exportedAt = DateTime.UtcNow,
                        source = "compatibility-empty-for-pre-0.8.4-retry",
                        changedElementCount = 0,
                        hadDeletion = false,
                        views = Array.Empty<object>()
                    }, new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
                }
                catch (Exception ex) { RevexDiagnostics.Warn("SYNC", "Could not create compatibility affected-plan manifest: " + ex.Message); }
            }

            _lastSyncFolder = folder;
            _pendingSync = new RevexSyncOutput(
                revision, folder, project, design, spec, ifc, fbx, mesh, meshManifest, meshPages, viewer,
                File.Exists(printing) ? printing : null, printingPdfs,
                File.Exists(affectedPlans) ? affectedPlans : null, affectedPlanPdfs, integrity,
                schedules, elements, printingSets, printingSheets, affectedPlanViews, changedElements);
            RevexDiagnostics.Info("SYNC", "Retrying preserved cloud publish without Revit export: " + folder);
            SetStatus("Retrying the preserved REVEX revision; Revit export will not run again.");
            OpenCompanion("bim");
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("SYNC", "Retry last publish failed.", ex);
            SetStatus("Retry publish failed: " + ex.Message);
        }
    }

    private static bool RevisionMatchesProject(string folder, string projectId)
    {
        if (string.IsNullOrWhiteSpace(projectId)) return false;
        string projectPath = Path.Combine(folder, "project.json");
        if (!File.Exists(projectPath)) return false;
        try
        {
            using JsonDocument json = JsonDocument.Parse(File.ReadAllText(projectPath));
            return json.RootElement.TryGetProperty("central", out JsonElement central) &&
                   central.TryGetProperty("projectId", out JsonElement value) &&
                   value.ValueKind == JsonValueKind.String &&
                   string.Equals(value.GetString(), projectId, StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }

    private async Task RunEnergySyncToCompanionAsync()
    {
        if (string.IsNullOrWhiteSpace(_projectId.Text))
        {
            _energySyncWaitingForProject = true;
            OpenCompanion("energy");
            SetStatus("Choose or create the REVEX project in the Companion Energy workspace. Engineering Sync will start automatically after selection.");
            return;
        }
        _energySyncWaitingForProject = false;
        try
        {
            _resolvedEnergyWeatherPath = EngineeringSyncService.ResolveWeatherFile(_energyWeather.Text.Trim(), _gbxmlOutput.Text.Trim());
            _energyWeather.Text = _resolvedEnergyWeatherPath;
            RevexDiagnostics.Dependency("ENERGY-SYNC", "Weather input fixed before Revit evidence run", true, _resolvedEnergyWeatherPath);
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("ENERGY-SYNC", "Weather input could not be resolved before SYNC ENGINEERING.", ex);
            ShowFailure("Energy Sync weather", ex.Message);
            return;
        }
        OpenCompanion("energy");
        RevexDiagnostics.Info("ENERGY-SYNC", $"clicked; project={_projectId.Text.Trim()}; destination=Companion/Spec/Energy; downstream=managed-server");
        SetStatus("Engineering Sync started. Revit will stop after verified evidence; the controlled REVEX server will run GeometryCo, Baseline/Proposed simulation, reports and EN-1 after the ≥80% hard-stop gate; 80–<95% results continue with a Companion quality warning, while sub-80% evidence is preserved for repair and is not published.");
        RunGbxmlEngineering(syncToCompanion: true);
    }

    private void SelectEnergyWeather()
    {
        var dialog = new OpenFileDialog
        {
            Title = "Select EnergyPlus weather file (.EPW)",
            Filter = "EnergyPlus weather (*.epw)|*.epw|All files (*.*)|*.*",
            CheckFileExists = true,
            Multiselect = false
        };
        if (dialog.ShowDialog(this) == true)
        {
            _energyWeather.Text = dialog.FileName;
            RevexDiagnostics.Info("ENERGY", "Weather EPW selected: " + dialog.FileName);
        }
    }

    private void RunGbxmlEngineering(bool syncToCompanion = false)
    {
        if (_gbxmlAwaitingRevit)
        {
            SetStatus("gbXML engineering run is already active.");
            return;
        }

        var settings = new GbxmlEngineeringSettings
        {
            AuditOnly = syncToCompanion ? false : _gbxmlAudit.IsChecked == true,
            OutputFolder = _gbxmlOutput.Text.Trim(),
            XmlName = _gbxmlName.Text.Trim(),
            PhaseName = _gbxmlPhase.Text.Trim(),
            CreateOrFixSpaces = syncToCompanion || _gbxmlFix.IsChecked == true,
            ExportDespiteBlockers = _gbxmlForce.IsChecked == true,
            MiniLmFolder = _gbxmlMiniLm.Text.Trim()
        };

        _gbxmlAwaitingRevit = true;
        _energySyncRequested = syncToCompanion;
        _activeGbxmlCorrelationId = RevexDiagnostics.NewCorrelationId(syncToCompanion ? "energy-sync" : "gbxml");
        _activeGbxmlInitiator = syncToCompanion ? "SYNC ENGINEERING button" : "gbXML Engineering button";
        _ = WatchGbxmlAsync();
        RevexDiagnostics.Info("GBXML", $"Engineering run requested. audit={settings.AuditOnly}; phase={(string.IsNullOrWhiteSpace(settings.PhaseName) ? "auto" : settings.PhaseName)}");
        SetStatus(settings.AuditOnly ? "Running gbXML preflight audit…" : "Preparing Spaces and exporting gbXML…");

        _handler.Enqueue(new RevitRequest(
            RevitRequestKind.GbxmlEngineering,
            CurrentSettings(),
            result => Dispatcher.BeginInvoke(new Action(() => HandleGbxmlResult(result))),
            settings)
        {
            CorrelationId = _activeGbxmlCorrelationId,
            Initiator = _activeGbxmlInitiator,
            ProjectBindingCandidate = syncToCompanion ? CurrentProjectBindingCandidate() : null,
            AllowProjectRebind = syncToCompanion && _explicitProjectSelectionPending
        });
        if (syncToCompanion) _explicitProjectSelectionPending = false;
        _externalEvent.Raise();
    }

    private void HandleGbxmlResult(RevitRequestResult result)
    {
        string correlationId = _activeGbxmlCorrelationId;
        string initiator = _activeGbxmlInitiator;
        using var workflow = RevexDiagnostics.BeginWorkflow("ENGINEERING_SYNC_CALLBACK", initiator, correlationId);
        _gbxmlAwaitingRevit = false;
        bool energySyncRequested = _energySyncRequested;
        _energySyncRequested = false;
        ApplyResolvedProjectBinding(result.ProjectBinding);
        GbxmlEngineeringOutput? output = result.EngineeringOutput;
        if (output != null)
        {
            _lastGbxmlFolder = output.OutputFolder;
            string files = string.Join(" · ", new[]
            {
                string.IsNullOrWhiteSpace(output.GbxmlPath) ? null : "XML " + Path.GetFileName(output.GbxmlPath),
                string.IsNullOrWhiteSpace(output.ReportPath) ? null : "REPORT " + Path.GetFileName(output.ReportPath),
                string.IsNullOrWhiteSpace(output.SummaryPath) ? null : "SUMMARY " + Path.GetFileName(output.SummaryPath)
            }.Where(x => x != null));
            _gbxmlLastResult.Text = output.Status + (files.Length > 0 ? "\n" + files : "") + "\n" + output.OutputFolder;
        }

        RevexDiagnostics.Info("GBXML", $"UI callback. success={result.Success}; {result.Message}");
        if (result.Success)
        {
            if (energySyncRequested && output != null)
            {
                try
                {
                    RevexProjectBinding resolvedBinding = result.ProjectBinding
                        ?? throw new InvalidOperationException("The active Revit document project binding was not returned with Engineering evidence.");
                    EngineeringSyncOutput revision = new EngineeringSyncService().Create(output, resolvedBinding, _resolvedEnergyWeatherPath);
                    _lastEngineeringSync = revision;
                    _pendingEngineeringSync = revision;
                    SetStatus($"{revision.Revision} passed the Revit evidence gate. Revit writes are finished. REVEX is publishing the immutable gbXML + verified EPW package; all downstream Energy work runs in the controlled server environment.");
                    SendEnergyStatus("server-upload", true, "≥80% Revit hard-stop gate passed. Publishing immutable engineering evidence, EN/Z page evidence, and Weather file (.EPW) to the managed REVEX Energy server…", revision.Revision);
                    _ = PublishPendingEngineeringSyncAsync();
                }
                catch (Exception ex)
                {
                    RevexDiagnostics.Error("ENERGY-SYNC", "Could not commit the separate Engineering Sync revision.", ex);
                    workflow.Complete(false, "gbXML passed but immutable Engineering Sync commit failed: " + ex.Message);
                    ShowFailure("Energy Sync", ex.Message);
                    _activeGbxmlCorrelationId = "";
                    _activeGbxmlInitiator = "";
                    return;
                }
            }
            else
            {
                SetStatus(result.Message);
            }
            workflow.Complete(true, energySyncRequested ? "gbXML and immutable Engineering Sync revision completed" : result.Message);
            _activeGbxmlCorrelationId = "";
            _activeGbxmlInitiator = "";
            return;
        }

        string detail = result.Message;
        if (output != null && !string.IsNullOrWhiteSpace(output.SummaryPath))
            detail += " Report preserved at " + output.SummaryPath;
        workflow.Complete(false, detail);
        _activeGbxmlCorrelationId = "";
        _activeGbxmlInitiator = "";
        ShowFailure("gbXML engineering", detail);
    }

    private void OpenGbxmlFolder()
    {
        string folder = _lastGbxmlFolder ?? "";
        if (string.IsNullOrWhiteSpace(folder))
            folder = string.IsNullOrWhiteSpace(_gbxmlOutput.Text) ? AppPaths.Engineering : _gbxmlOutput.Text.Trim();
        try
        {
            Directory.CreateDirectory(folder);
            Process.Start(new ProcessStartInfo { FileName = folder, UseShellExecute = true });
        }
        catch (Exception ex)
        {
            ShowFailure("gbXML folder", ex.Message);
        }
    }

    private void OpenSyncFolder()
    {
        AppPaths.Ensure();
        string folder = _lastSyncFolder ?? AppPaths.SyncRevisions;
        Directory.CreateDirectory(folder);
        Process.Start(new ProcessStartInfo
        {
            FileName = folder,
            UseShellExecute = true
        });
    }

    private void CaptureCurrent()
    {
        SetStatus("Capturing open Revit 3D view…");
        var settings = CurrentSettings();

        _handler.Enqueue(new RevitRequest(
            RevitRequestKind.CaptureCurrentView,
            settings,
            result => Dispatcher.BeginInvoke(new Action(async () => await HandleCaptureResultAsync(result))))
        {
            CorrelationId = RevexDiagnostics.NewCorrelationId("capture"),
            Initiator = "Capture current view button"
        });

        _externalEvent.Raise();
    }

    private void CaptureBatch()
    {
        SetStatus("Capturing named Revit 3D views…");
        var settings = CurrentSettings() with
        {
            BatchNameContains = _batchToken.Text.Trim()
        };

        _handler.Enqueue(new RevitRequest(
            RevitRequestKind.CaptureBatch,
            settings,
            result => Dispatcher.BeginInvoke(new Action(async () => await HandleCaptureResultAsync(result))))
        {
            CorrelationId = RevexDiagnostics.NewCorrelationId("capture-batch"),
            Initiator = "Capture batch button"
        });

        _externalEvent.Raise();
    }

    private async Task HandleCaptureResultAsync(RevitRequestResult result)
    {
        if (!result.Success)
        {
            SetStatus(result.Message);
            return;
        }

        _packages.Clear();
        _packages.AddRange(result.Packages);
        _queue.Items.Clear();

        foreach (TransferPackage p in _packages)
            _queue.Items.Add(p.ViewName);

        _selectedPackageIndex = _packages.Count > 0 ? 0 : -1;
        if (_selectedPackageIndex >= 0)
        {
            _queue.SelectedIndex = 0;
            _prompt.Text = _packages[0].Prompt;

            var attach = await RendairWebBridge.AttachBaseImageAsync(_web, _packages[0].ImagePath, _renderFrames.ToArray());
            var inject = await RendairWebBridge.InjectPromptAsync(_web, _packages[0].Prompt, _renderFrames.ToArray());

            SetStatus($"{result.Message} {attach.message} {inject.message}");
        }
        else
        {
            SetStatus(result.Message);
        }
    }

    private async Task AttachSelectedAsync()
    {
        if (_selectedPackageIndex < 0 || _selectedPackageIndex >= _packages.Count)
        {
            SetStatus("Capture a Revit view first.");
            return;
        }

        TransferPackage package = _packages[_selectedPackageIndex];
        var attach = await RendairWebBridge.AttachBaseImageAsync(_web, package.ImagePath, _renderFrames.ToArray());
        var inject = await RendairWebBridge.InjectPromptAsync(_web, _prompt.Text, _renderFrames.ToArray());
        SetStatus($"{attach.message} {inject.message}");
    }

    private RenderSettings CurrentSettings() => new()
    {
        AutoMaterialIntent = _autoMaterials.IsChecked == true,
        PreserveGeometry = true,
        RealisticOnly = true,
        Environment = _environment.SelectedItem?.ToString() ?? "Natural daylight",
        Staging = _staging.SelectedItem?.ToString() ?? "Preserve modeled objects only",
        People = _people.SelectedItem?.ToString() ?? "None",
        PixelSize = _bridgeSettings.DefaultPixelSize,
        BatchNameContains = _batchToken.Text.Trim()
    };

    private void SaveBridgeSettings()
    {
        _bridgeSettings.LiberProjectId = _projectId.Text.Trim();
        _bridgeSettings.LiberSpecProjectId = _specProjectId.Text.Trim();
        SettingsService.Save(_bridgeSettings);
    }

    private RevexProjectBinding CurrentProjectBindingCandidate()
    {
        string projectId = _projectId.Text.Trim();
        return new RevexProjectBinding
        {
            ProjectId = projectId,
            SpecProjectId = SettingsService.ExpectedSpecProjectId(projectId),
            ProjectName = _activeProjectName
        };
    }

    private void ApplyResolvedProjectBinding(RevexProjectBinding? binding)
    {
        if (binding == null || string.IsNullOrWhiteSpace(binding.ProjectId)) return;
        if (!string.Equals(binding.BindingVersion, "active-revit-evidence-v1", StringComparison.Ordinal))
        {
            RevexDiagnostics.Warn("PROJECT", $"Ignored completion binding without active-document evidence: source={binding.BindingSource}; project={binding.ProjectId}");
            return;
        }
        try
        {
            _applyingResolvedProjectBinding = true;
            _projectId.Text = binding.ProjectId;
            _engineeringProjectId.Text = binding.ProjectId;
            _specProjectId.Text = SettingsService.ExpectedSpecProjectId(binding.ProjectId);
            if (!string.IsNullOrWhiteSpace(binding.ProjectName)) _activeProjectName = binding.ProjectName;
            SaveBridgeSettings();
        }
        finally { _applyingResolvedProjectBinding = false; }
        RevexDiagnostics.Info("PROJECT", $"UI accepted evidence-verified active-document binding: document={binding.DocumentTitle}; fingerprint={binding.DocumentFingerprint}; project={binding.ProjectId}; source={binding.BindingSource}; evidence={binding.IdentityEvidenceDigest[..Math.Min(16, binding.IdentityEvidenceDigest.Length)]}");
    }

    private void OpenRenderBridge()
    {
        RevexDiagnostics.Info("RENDER", "Opening Rendair bridge: " + _bridgeSettings.Rendair3DToolUrl);
        try
        {
            if (_controlsColumn != null) _controlsColumn.Width = new GridLength(390);
            if (_web.CoreWebView2 == null)
            {
                SetStatus("Rendair browser is still initializing.");
                return;
            }

            SaveBridgeSettings();
            _web.Source = new Uri(_bridgeSettings.Rendair3DToolUrl);
            SetStatus("Opening Rendair. Your LIBER/Rendair WebView2 sessions stay signed in.");
        }
        catch (Exception ex)
        {
            ShowFailure("Render", "Could not open Rendair: " + ex.Message);
        }
    }

    private void QuickRenderCurrentView()
    {
        RevexDiagnostics.Info("RENDER", "Render current view requested. Prompt=" + _prompt.Text.Trim());
        if (_web.CoreWebView2 == null)
        {
            SetStatus("Rendair browser is still initializing.");
            return;
        }

        SaveBridgeSettings();
        _renderAwaitingRevit = true;
        _ = WatchPendingAsync("RENDER CAPTURE", () => _renderAwaitingRevit);
        SetStatus("Capturing the active Revit 3D viewport for Rendair…");
        _handler.Enqueue(new RevitRequest(
            RevitRequestKind.CaptureCurrentView,
            CurrentSettings(),
            result => Dispatcher.BeginInvoke(new Action(async () => await HandleQuickRenderCaptureAsync(result))))
        {
            CorrelationId = RevexDiagnostics.NewCorrelationId("quick-render"),
            Initiator = "Quick Render current view button"
        });
        _externalEvent.Raise();
        RevexDiagnostics.Info("RENDER", "Capture ExternalEvent raised; waiting for Revit callback.");
    }

    private async Task HandleQuickRenderCaptureAsync(RevitRequestResult result)
    {
        _renderAwaitingRevit = false;
        RevexDiagnostics.Info("RENDER", $"Capture callback received. success={result.Success} packages={result.Packages.Count} message={result.Message}");
        if (!result.Success || result.Packages.Count == 0)
        {
            ShowFailure("Render failed", result.Message);
            return;
        }

        TransferPackage package = result.Packages[0];
        string userLine = _prompt.Text.Trim();
        _pendingQuickRender = package;
        _pendingQuickPrompt = string.IsNullOrWhiteSpace(userLine)
            ? package.Prompt
            : userLine + "\n\nREVEX / Revit context and non-destructive constraints:\n" + package.Prompt;
        _pendingRenderJobId = "";

        Uri? current = _web.Source;
        if (current == null || !current.Host.EndsWith("rendair.ai", StringComparison.OrdinalIgnoreCase))
        {
            OpenRenderBridge();
            return;
        }

        await ExecutePendingQuickRenderAsync();
    }

    private async Task ExecutePendingQuickRenderAsync()
    {
        if (_pendingQuickRender == null) return;
        TransferPackage package = _pendingQuickRender;
        string prompt = _pendingQuickPrompt;

        (bool ok, string message) attach = (false, "Rendair upload field is not ready.");
        (bool ok, string message) inject = (false, "Rendair prompt field is not ready.");
        (bool ok, string message) submit = (false, "Rendair render control is not ready.");

        for (int attempt = 0; attempt < 8; attempt++)
        {
            RevexDiagnostics.Info("RENDER", $"Rendair automation attempt {attempt + 1}/8 frames={_renderFrames.Count}");
            CoreWebView2Frame[] frames = _renderFrames.ToArray();
            attach = await RendairWebBridge.AttachBaseImageAsync(_web, package.ImagePath, frames);
            if (attach.ok)
            {
                inject = await RendairWebBridge.InjectPromptAsync(_web, prompt, frames);
                if (inject.ok)
                {
                    submit = await RendairWebBridge.SubmitAsync(_web, frames);
                    if (submit.ok) break;
                }
            }
            RevexDiagnostics.Warn("RENDER", $"Attempt {attempt + 1} incomplete: attach={attach.ok} inject={inject.ok} submit={submit.ok}");
            await Task.Delay(650);
        }

        bool ok = attach.ok && inject.ok && submit.ok;
        string status = $"{attach.message} {inject.message} {submit.message}";
        if (ok) RevexDiagnostics.Info("RENDER", "Rendair automation complete. " + status);
        else RevexDiagnostics.Error("RENDER", "Rendair automation failed. " + status);
        SetStatus(status);
        if (!string.IsNullOrWhiteSpace(_pendingRenderJobId))
            SendRenderStatus(ok, _pendingRenderJobId, status);

        if (ok)
        {
            _pendingQuickRender = null;
            _pendingQuickPrompt = "";
            _pendingRenderJobId = "";
        }
        else
        {
            RevexDiagnostics.Warn("RENDER", "Rendair bridge remains interactive; automation did not complete. " + status);
            SetStatus(status + " Sign in to Rendair if needed, then press Enter in the render line again.");
        }
    }

    private void TrackRenderFrame(CoreWebView2Frame frame)
    {
        _renderFrames.Add(frame);
        frame.Destroyed += (_, _) => _renderFrames.Remove(frame);
    }

    private async Task HandleNavigationCompletedAsync(ulong navigationId, bool navigationSucceeded, CoreWebView2WebErrorStatus webErrorStatus)
    {
        Uri? current = _web.Source;
        if (current == null) return;

        // WebView2 may report a failed intermediate redirect after a later Rendair
        // navigation has already become current. Never convert that stale event into
        // a modal failure: the visible page is the source of truth.
        if (current.Host.EndsWith("rendair.ai", StringComparison.OrdinalIgnoreCase))
        {
            if (!navigationSucceeded)
            {
                RevexDiagnostics.Warn("WEB", $"Transient Rendair navigation event ignored. id={navigationId} status={webErrorStatus} current={current}");
                SetStatus("Rendair navigation is still settling; REVEX remains responsive.");
                _ = ConfirmRendairReadyAsync(navigationId);
                return;
            }

            RevexDiagnostics.Info("WEB", $"Rendair navigation ready. id={navigationId} current={current}");
            if (_pendingQuickRender != null)
            {
                await Task.Delay(700);
                await ExecutePendingQuickRenderAsync();
            }
            return;
        }

        string source = current.AbsoluteUri;
        bool onRevex = source.Contains("/apps/revex/", StringComparison.OrdinalIgnoreCase);

        if (navigationSucceeded && onRevex)
        {
            await InstallNativeProjectSelectionBridgeAsync();
            var managedBridge = await EngineeringCompanionWebBridge.EnsureManagedEnergyBridgeAsync(_web);
            if (!managedBridge.ok)
                RevexDiagnostics.Warn("ENERGY", managedBridge.message);
            await ApplyEnergyCompanionNativePolicyAsync();
            await RefreshProjectBindingFromCompanionAsync("navigation");
        }

        if (_pendingSync == null && _pendingEngineeringSync == null && _pendingEnergyResult == null) return;

        if (!navigationSucceeded)
        {
            RevexDiagnostics.Warn("WEB", $"Companion navigation failed. id={navigationId} status={webErrorStatus} current={current}");
            if (_pendingSync != null)
                OpenOfflineCompanion(_pendingSync, "viewer", "Live Companion could not be reached.");
            else
                SetStatus("Live Companion could not be reached. The complete Engineering revision remains preserved locally for retry.");
            return;
        }

        if (!onRevex)
            return;

        if (_pendingSync != null)
        {
            RevexSyncOutput output = _pendingSync;
            var attached = await CompanionWebBridge.AttachSyncPackageAsync(_web, output);
            SetStatus(attached.message);
            if (attached.ok)
                _pendingSync = null;
            else
            {
                OpenOfflineCompanion(output, "viewer", attached.message);
                return;
            }
        }

        if (_pendingEngineeringSync != null)
        {
            var attached = await EngineeringCompanionWebBridge.AttachEngineeringSyncAsync(_web, _pendingEngineeringSync);
            SetStatus(attached.message);
            if (!attached.ok)
                RevexDiagnostics.Warn("ENERGY-SYNC", "Native managed-server handoff did not start: " + attached.message);
            // Keep the local immutable revision pending until the browser bridge confirms
            // CLOUD_UPLOAD_PASSED. This prevents a transient auth/navigation race from
            // discarding the only retry source.
        }

        if (_pendingEnergyResult != null)
        {
            var attached = await EngineeringCompanionWebBridge.AttachEnergyResultAsync(_web, _pendingEnergyResult);
            SetStatus(attached.message);
            if (attached.ok) _pendingEnergyResult = null;
        }
    }

    private async Task ApplyEnergyCompanionNativePolicyAsync()
    {
        if (_web.CoreWebView2 == null) return;
        try
        {
            await _web.CoreWebView2.ExecuteScriptAsync("""
              (() => {
                // Revit owns evidence only; the managed server owns every downstream Energy stage.
                // Harden an older hosted Companion so stale local-run/identity controls cannot
                // reopen an uncontrolled workstation workflow.
                document.querySelectorAll('[data-energy-applicant],#energy-seal').forEach((node) => node.remove());

                // Hosted Companion can lag the native build behind CDN/browser caches.
                // The native host owns the active integrity contract, so never let an
                // Normalize any stale hosted wording to the current 80% hard-stop / 95% review-quality contract.
                const energyRoot = document.getElementById('view-energy') || document.body;
                const rewriteIntegrityText = (value) => {
                  let text = String(value || '');
                  text = text.replace(/≥\s*98%/g, '≥80%');
                  text = text.replace(/>=\s*98%/g, '>=80%');
                  text = text.replace(/98%\s+integrity\s+publication\s+gate/gi, '80% hard-stop publication gate');
                  text = text.replace(/98%\s+integrity\s+gate/gi, '80% hard-stop gate');
                  text = text.replace(/98%\s+Engineering\s+Sync/gi, '80% hard-stop Engineering Sync');
                  return text;
                };
                try {
                  const walker = document.createTreeWalker(energyRoot, NodeFilter.SHOW_TEXT);
                  const nodes = [];
                  while (walker.nextNode()) nodes.push(walker.currentNode);
                  nodes.forEach((node) => {
                    const revised = rewriteIntegrityText(node.nodeValue);
                    if (revised !== node.nodeValue) node.nodeValue = revised;
                  });
                  const runStatus = document.getElementById('energy-run-status');
                  if (runStatus && /(waiting for|published).*98%/i.test(runStatus.textContent || '')) {
                    runStatus.textContent = 'Waiting for an Engineering Sync revision that clears the ≥80% hard-stop gate. Results below 95% are published with a quality warning; sub-80% evidence is preserved for repair.';
                  }
                  const sourceSummary = document.getElementById('energy-source-summary');
                  if (sourceSummary && /(engineering sync|98%)/i.test(sourceSummary.textContent || '') ) {
                    sourceSummary.innerHTML = 'In Revit, click <b>SYNC ENGINEERING</b>. The downstream chain starts after the ≥80% hard-stop gate. Results below 95% stay visible as a Companion quality warning; sub-80% evidence never publishes.';
                  }
                } catch (_) {}

                const form = document.getElementById('energy-run-form');
                if (form) {
                  form.querySelectorAll('label,fieldset,#energy-run').forEach((node) => node.remove());
                  const eyebrow = form.querySelector('.eyebrow');
                  if (eyebrow) eyebrow.textContent = '02 · MANAGED SERVER';
                  const heading = form.querySelector('h2');
                  if (heading) heading.textContent = 'GeometryCo → Baseline + Proposed';
                  let summary = form.querySelector('.energy-native-policy');
                  if (!summary) {
                    summary = document.createElement('p');
                    summary.className = 'energy-summary energy-native-policy';
                    const status = document.getElementById('energy-run-status');
                    form.insertBefore(summary, status || null);
                  }
                  summary.textContent = 'No second run step. SYNC ENGINEERING publishes verified gbXML + EPW; the managed REVEX server runs GeometryCo/OpenStudio/EnergyPlus and EN-1. Applicant/modeler/signature/seal remain blank.';
                }
              })();
            """);
            RevexDiagnostics.Info("ENERGY", "Native single-chain policy applied to Companion DOM.");
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("ENERGY", "Could not apply Companion single-chain UI hardening: " + ex.Message);
        }
    }

    private async Task ConfirmRendairReadyAsync(ulong navigationId)
    {
        await Task.Delay(1200);
        if (Dispatcher.HasShutdownStarted) return;
        _ = Dispatcher.BeginInvoke(new Action(async () =>
        {
            Uri? source = _web.Source;
            bool onRendair = source != null && source.Host.EndsWith("rendair.ai", StringComparison.OrdinalIgnoreCase);
            RevexDiagnostics.Info("WEB", $"Rendair settle probe id={navigationId} onRendair={onRendair} current={source}");
            if (!onRendair) return;
            SetStatus("Rendair loaded. REVEX bridge is ready.");
            if (_pendingQuickRender != null)
                await ExecutePendingQuickRenderAsync();
        }));
    }

    private void OpenOfflineCompanion(RevexSyncOutput output, string mode, string reason)
    {
        try
        {
            string index = Path.Combine(output.RootFolder, "index.html");
            if (!File.Exists(index))
            {
                SetStatus(reason + " The offline Companion was not found; use OPEN SYNC FOLDER to inspect the complete revision.");
                return;
            }

            _web.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "revex.local",
                output.RootFolder,
                CoreWebView2HostResourceAccessKind.Allow);
            _pendingSync = null;
            _web.Source = new Uri("https://revex.local/index.html#" + Uri.EscapeDataString(mode));
            SetStatus(reason + " Opened the local revision; cloud publishing can be retried after LIBER sign-in/network recovery.");
        }
        catch (Exception ex)
        {
            SetStatus(reason + " Offline Companion also failed: " + ex.Message);
        }
    }

    private async Task InstallNativeProjectSelectionBridgeAsync()
    {
        try
        {
            if (_web.CoreWebView2 == null) return;
            string result = await _web.ExecuteScriptAsync("""
            (() => {
              const select = document.getElementById('project-select');
              if (!select || !window.chrome?.webview?.postMessage) return false;
              const params = new URLSearchParams(location.search);
              const urlProjectId = String(params.get('projectId') || '').trim();
              const urlSpecProjectId = String(params.get('specProjectId') || '').trim();
              const hasUrlOption = !!urlProjectId && [...select.options].some((option) => String(option.value || '').trim() === urlProjectId);
              if (!String(select.value || '').trim() && urlProjectId && !hasUrlOption) {
                const provisional = document.createElement('option');
                provisional.value = urlProjectId;
                provisional.textContent = urlProjectId;
                provisional.dataset.revexNativeProvisional = '1';
                select.appendChild(provisional);
                select.value = urlProjectId;
              }
              const post = (event) => {
                const selected = String(select.value || '').trim();
                const currentUrlProjectId = String(new URLSearchParams(location.search).get('projectId') || '').trim();
                const currentHasUrlOption = !!currentUrlProjectId && [...select.options].some((option) => String(option.value || '').trim() === currentUrlProjectId && !option.dataset.revexNativeProvisional);
                const projectId = selected || (!currentHasUrlOption ? currentUrlProjectId : '');
                if (!projectId) return;
                const option = select.selectedOptions && select.selectedOptions[0];
                const currentParams = new URLSearchParams(location.search);
                window.chrome.webview.postMessage({
                  type: 'liber:revex-project-selected',
                  projectId,
                  specProjectId: String(currentParams.get('specProjectId') || urlSpecProjectId || '').trim() || null,
                  projectName: String(option?.dataset?.revexNativeProvisional ? '' : option?.textContent || '').trim(),
                  source: 'native-selection-bridge',
                  explicitUserSelection: Boolean(event?.isTrusted && event.type === 'change')
                });
              };
              if (!select.dataset.revexNativeProjectBridge) {
                select.dataset.revexNativeProjectBridge = '1';
                select.addEventListener('change', post);
              }
              post(null);
              return true;
            })();
            """);
            RevexDiagnostics.Info("PROJECT", "Native project-selection bridge installed=" + result);
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("PROJECT", "Could not install native project-selection bridge: " + ex.Message);
        }
    }

    private async Task RefreshProjectBindingFromCompanionAsync(string reason)
    {
        try
        {
            if (_web.CoreWebView2 == null) return;
            Uri? current = _web.Source;
            if (current == null ||
                !current.AbsoluteUri.Contains("/apps/revex/", StringComparison.OrdinalIgnoreCase))
                return;

            string result = await _web.ExecuteScriptAsync("""
            (() => {
              const select = document.getElementById('project-select');
              const params = new URLSearchParams(location.search);
              const selected = String(select?.value || '').trim();
              const urlProjectId = String(params.get('projectId') || '').trim();
              const hasUrlOption = !!urlProjectId && !!select && [...select.options].some((option) => String(option.value || '').trim() === urlProjectId && !option.dataset.revexNativeProvisional);
              const projectId = selected || (!hasUrlOption ? urlProjectId : '');
              if (!projectId) return null;
              const option = select?.selectedOptions && select.selectedOptions[0];
              return {
                projectId,
                projectName: String(option?.dataset?.revexNativeProvisional ? '' : option?.textContent || '').trim(),
                specProjectId: String(params.get('specProjectId') || '').trim(),
                source: selected ? 'project-select' : 'url-fallback'
              };
            })();
            """);
            if (string.IsNullOrWhiteSpace(result) ||
                string.Equals(result, "null", StringComparison.OrdinalIgnoreCase))
            {
                RevexDiagnostics.Warn("PROJECT", "Companion probe found no active project. reason=" + reason);
                return;
            }

            using JsonDocument doc = JsonDocument.Parse(result);
            JsonElement root = doc.RootElement;
            string projectId = ReadString(root, "projectId", "").Trim();
            if (string.IsNullOrWhiteSpace(projectId)) return;

            string specProjectId = ReadString(root, "specProjectId", "").Trim();
            string projectName = ReadString(root, "projectName", "").Trim();
            string nativeProjectId = _projectId.Text.Trim();
            if (string.Equals(nativeProjectId, projectId, StringComparison.Ordinal))
            {
                if (!string.IsNullOrWhiteSpace(projectName)) _activeProjectName = projectName;
                string expectedSpec = SettingsService.ExpectedSpecProjectId(projectId);
                if (specProjectId.Length > 0 && !string.Equals(specProjectId, expectedSpec, StringComparison.Ordinal))
                    RevexDiagnostics.Warn("PROJECT", $"Passive Companion probe exposed a mixed project pair and was ignored: project={projectId}; spec={specProjectId}; expected={expectedSpec}; reason={reason}");
                RevexDiagnostics.Info("PROJECT", $"Passive Companion project observation matched native binding: {projectId}; reason={reason}");
            }
            else
            {
                RevexDiagnostics.Warn("PROJECT", $"Passive Companion project observation ignored: browser={projectId}; activeDocumentBinding={nativeProjectId}; reason={reason}");
            }
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("PROJECT", "Companion project probe failed (" + reason + "): " + ex.Message);
        }
    }

    private async Task PersistProjectBindingIntoCompanionAsync(string projectId, string specProjectId, string projectName)
    {
        try
        {
            if (_web.CoreWebView2 == null || string.IsNullOrWhiteSpace(projectId)) return;
            Uri? current = _web.Source;
            if (current == null || !current.AbsoluteUri.Contains("/apps/revex/", StringComparison.OrdinalIgnoreCase)) return;

            string idJson = JsonSerializer.Serialize(projectId.Trim());
            string specJson = JsonSerializer.Serialize(specProjectId?.Trim() ?? "");
            string nameJson = JsonSerializer.Serialize(projectName?.Trim() ?? "");
            string result = await _web.ExecuteScriptAsync($$"""
            (() => {
              const projectId = {{idJson}};
              const specProjectId = {{specJson}};
              const projectName = {{nameJson}};
              const url = new URL(location.href);
              url.searchParams.set('projectId', projectId);
              if (specProjectId) url.searchParams.set('specProjectId', specProjectId);
              else url.searchParams.delete('specProjectId');
              history.replaceState(history.state, '', url);

              const select = document.getElementById('project-select');
              if (select) {
                let option = [...select.options].find((row) => String(row.value || '').trim() === projectId);
                if (!option) {
                  option = document.createElement('option');
                  option.value = projectId;
                  option.textContent = projectName || projectId;
                  option.dataset.revexNativeProvisional = '1';
                  select.appendChild(option);
                } else if (projectName && option.dataset.revexNativeProvisional) {
                  option.textContent = projectName;
                }
                select.value = projectId;
              }
              window.dispatchEvent(new CustomEvent('revex:native-project-binding', {
                detail: { projectId, specProjectId, view: new URLSearchParams(location.search).get('view') || 'bim' }
              }));
              return { projectId, specProjectId, href: location.href };
            })();
            """);
            RevexDiagnostics.Info("PROJECT", "Companion binding persisted into URL/selector: " + result);
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("PROJECT", "Could not persist project binding into Companion URL/selector: " + ex.Message);
        }
    }

    private void HandleCompanionMessage(string json)
    {
        try
        {
            using JsonDocument message = JsonDocument.Parse(json);
            JsonElement root = message.RootElement;
            if (!root.TryGetProperty("type", out JsonElement type))
                return;

            string kind = type.GetString() ?? "";
            if (kind == "liber:revex-project-selected")
            {
                string source = ReadString(root, "source", "companion");
                bool explicitUserSelection = root.TryGetProperty("explicitUserSelection", out JsonElement explicitValue) &&
                                             explicitValue.ValueKind == JsonValueKind.True;
                string selectedProjectId = ReadString(root, "projectId", "").Trim();
                if (!explicitUserSelection || !string.Equals(source, "native-selection-bridge", StringComparison.Ordinal))
                {
                    RevexDiagnostics.Info("PROJECT", $"Ignored passive Companion selection event: project={selectedProjectId}; source={source}; currentNative={_projectId.Text.Trim()}");
                    return;
                }
                if (selectedProjectId.Length == 0) return;

                _projectId.Text = selectedProjectId;
                _specProjectId.Text = SettingsService.ExpectedSpecProjectId(selectedProjectId);
                string selectedProjectName = ReadString(root, "projectName", "").Trim();
                if (!string.IsNullOrWhiteSpace(selectedProjectName)) _activeProjectName = selectedProjectName;
                _explicitProjectSelectionPending = true;
                SaveBridgeSettings();
                _ = PersistProjectBindingIntoCompanionAsync(_projectId.Text.Trim(), _specProjectId.Text.Trim(), _activeProjectName);
                SetStatus("Selected REVEX project will bind to the active Revit model on the next sync: " + _projectId.Text.Trim());

                if (_engineeringModeActive && _energySyncWaitingForProject && !string.IsNullOrWhiteSpace(_projectId.Text))
                {
                    _energySyncWaitingForProject = false;
                    RevexDiagnostics.Info("ENERGY-SYNC", "Project selected while Engineering Sync was waiting; starting Revit evidence automatically.");
                    Dispatcher.BeginInvoke(new Action(() => _ = RunEnergySyncToCompanionAsync()));
                }
                return;
            }

            if (kind == "liber:revex-render-request")
            {
                HandleRenderRequest(root);
                return;
            }

            if (kind == "liber:revex-managed-energy-status")
            {
                string stage = ReadString(root, "stage", "MANAGED_ENERGY");
                string managedMessage = ReadString(root, "message", "Managed Energy update");
                string managedRevision = ReadString(root, "revision", "");
                bool managedSucceeded = root.TryGetProperty("ok", out JsonElement managedOk) && managedOk.GetBoolean();

                string detail = $"stage={stage}; ok={managedSucceeded}; revision={managedRevision}; {managedMessage}";
                if (string.Equals(stage, "BROKER_FAILED", StringComparison.OrdinalIgnoreCase))
                    RevexDiagnostics.Error("ENERGY-SERVER", detail);
                else if (!managedSucceeded)
                    RevexDiagnostics.Warn("ENERGY-SERVER", detail);
                else
                    RevexDiagnostics.Info("ENERGY-SERVER", detail);

                SetStatus(managedMessage);

                if (string.Equals(stage, "CLOUD_UPLOAD_PASSED", StringComparison.OrdinalIgnoreCase))
                {
                    if (_pendingEngineeringSync != null &&
                        (string.IsNullOrWhiteSpace(managedRevision) || string.Equals(_pendingEngineeringSync.Revision, managedRevision, StringComparison.Ordinal)))
                    {
                        RevexDiagnostics.Info("ENERGY-SYNC", $"Cloud handoff confirmed for {(_pendingEngineeringSync.Revision)}; local retry handle released.");
                        _pendingEngineeringSync = null;
                    }
                }

                if (string.Equals(stage, "BROKER_COMPLETE", StringComparison.OrdinalIgnoreCase))
                    SendEnergyStatus("complete", true, managedMessage, ReadString(root, "resultRevision", managedRevision));
                else if (string.Equals(stage, "BROKER_FAILED", StringComparison.OrdinalIgnoreCase))
                    SendEnergyStatus("server-failed", false, managedMessage, managedRevision);
                return;
            }

            if (kind == "liber:revex-energy-run")
            {
                RevexDiagnostics.Warn("ENERGY", "Ignored legacy Companion local-run request. Managed server execution is authoritative in r31.");
                SendEnergyStatus("server-only", false, "Local OpenStudio execution is disabled. SYNC ENGINEERING publishes the verified revision to the managed REVEX Energy server automatically.");
                return;
            }

            if (kind == "liber:revex-diagnostic")
            {
                string correlationId = ReadString(root, "correlationId", RevexDiagnostics.NewCorrelationId("browser"));
                string initiator = ReadString(root, "initiator", "Companion browser");
                string level = ReadString(root, "level", "INFO");
                string stage = ReadString(root, "stage", "BROWSER");
                string text = ReadString(root, "message", "Companion diagnostic event");
                string stack = ReadString(root, "stack", "");
                using var browserWorkflow = RevexDiagnostics.BeginWorkflow("COMPANION_BROWSER", initiator, correlationId);
                string detail = string.IsNullOrWhiteSpace(stack) ? text : text + " | stack=" + stack;
                if (string.Equals(level, "ERROR", StringComparison.OrdinalIgnoreCase)) RevexDiagnostics.Error("COMPANION", detail);
                else if (string.Equals(level, "WARN", StringComparison.OrdinalIgnoreCase)) RevexDiagnostics.Warn("COMPANION", detail);
                else RevexDiagnostics.Stage("COMPANION", stage, "INFO", detail);
                browserWorkflow.Complete(!string.Equals(level, "ERROR", StringComparison.OrdinalIgnoreCase), $"browser event level={level}; stage={stage}");
                return;
            }

            if (kind == "liber:revex-auth-state")
            {
                bool authCloud = root.TryGetProperty("cloud", out JsonElement authCloudValue) && authCloudValue.GetBoolean();
                string email = ReadString(root, "email", "");
                RevexDiagnostics.Info("AUTH", authCloud
                    ? "LIBER cloud session active" + (string.IsNullOrWhiteSpace(email) ? "" : ": " + email)
                    : "LIBER cloud session is signed out; REVEX is in complete local-preview mode.");
                SetStatus(authCloud
                    ? "LIBER account connected. New revisions can publish across devices."
                    : "Local preview mode: BIM, Design Book, Spec Book and Docs remain usable here. Open LIBER Account, sign in, then RETRY LAST PUBLISH to share the revision.");
                return;
            }

            if (kind == "liber:revex-revision-projection")
            {
                string projectionRevision = ReadString(root, "revision", "revision");
                string viewerElements = root.TryGetProperty("viewerElements", out JsonElement ve) ? ve.ToString() : "0";
                string designChapters = root.TryGetProperty("designChapters", out JsonElement dc) ? dc.ToString() : "0";
                string designPositions = root.TryGetProperty("designPositions", out JsonElement dp) ? dp.ToString() : "0";
                string specSchedules = root.TryGetProperty("specSchedules", out JsonElement ss) ? ss.ToString() : "0";
                RevexDiagnostics.Info("PROJECTION", $"{projectionRevision}: BIM elements={viewerElements}; Design Book chapters={designChapters}; positions={designPositions}; Spec schedules={specSchedules}");
                return;
            }

            if (kind == "liber:revex-sync-progress")
            {
                string stage = ReadString(root, "stage", "publish");
                string path = ReadString(root, "path", "");
                string error = ReadString(root, "error", "");
                string bytes = root.TryGetProperty("bytes", out JsonElement bytesValue) ? bytesValue.ToString() : "";
                string detail = stage;
                if (!string.IsNullOrWhiteSpace(path)) detail += " · " + path;
                if (!string.IsNullOrWhiteSpace(bytes)) detail += " · " + bytes + " bytes";
                if (!string.IsNullOrWhiteSpace(error)) detail += " · " + error;
                RevexDiagnostics.Info("PUBLISH", detail);
                SetStatus("Cloud publish: " + stage);
                return;
            }

            if (kind != "liber:revex-sync-result")
                return;

            bool ok = root.TryGetProperty("ok", out JsonElement okValue) && okValue.GetBoolean();
            if (!ok)
            {
                string error = root.TryGetProperty("error", out JsonElement errorValue)
                    ? errorValue.GetString() ?? "Unknown Companion error"
                    : "Unknown Companion error";
                string detail = "REVEX Companion rejected the sync: " + error;
                if (!string.IsNullOrWhiteSpace(_lastSyncFolder))
                    detail += "\n\nThe complete local revision is preserved at:\n" + _lastSyncFolder;
                ShowFailure("REVEX cloud publish failed", detail);
                return;
            }

            string revision = root.TryGetProperty("revision", out JsonElement revValue)
                ? revValue.GetString() ?? "revision"
                : "revision";
            bool cloud = root.TryGetProperty("cloud", out JsonElement cloudValue) && cloudValue.GetBoolean();
            SetStatus(cloud
                ? $"{revision} is live in REVEX Companion. RVT remained unchanged."
                : $"{revision} is a complete local REVEX revision: BIM, Design Book, Spec Book and Docs are available on this device. Open LIBER Account, sign in, then use RETRY LAST PUBLISH to share it across devices.");
        }
        catch
        {
            // Ignore messages from other hosted apps in the shared browser.
        }
    }

    private async Task RunAutomaticEnergyPipelineAsync(EngineeringSyncOutput source, string parentCorrelationId)
    {
        if (_energyPipelineRunning)
        {
            RevexDiagnostics.Warn("ENERGY", "Automatic downstream pipeline skipped because another Energy pipeline is already active.");
            return;
        }

        string correlationId = RevexDiagnostics.NewCorrelationId("energy-auto");
        using var workflow = RevexDiagnostics.BeginWorkflow("AUTOMATIC_ENERGY_PACKAGE", "SYNC ENGINEERING automatic downstream", correlationId);
        var request = new EnergyPipelineRequest
        {
            CorrelationId = correlationId,
            ParentCorrelationId = parentCorrelationId,
            Initiator = "SYNC ENGINEERING automatic downstream",
            ProjectId = source.ProjectId,
            ProjectName = string.IsNullOrWhiteSpace(_activeProjectName) ? source.ProjectId : _activeProjectName,
            OpenStudioCli = "",
            WeatherFilePath = _energyWeather.Text.Trim(),
            StandardVersion = "NYCECC 2020"
        };

        _energyPipelineRunning = true;
        SendEnergyStatus("running", true, "Engineering evidence passed. GeometryCo → Baseline/Proposed → EnergyPlus → reports → filing package is running automatically…");
        SetStatus("Energy pipeline is running outside Revit. The RVT is no longer being accessed.");
        try
        {
            EnergyPipelineOutput output = await new EnergyPipelineService().RunAsync(source, request);
            _pendingEnergyResult = output;
            bool complete = string.Equals(output.Status, "COMPLETE", StringComparison.OrdinalIgnoreCase);
            SendEnergyStatus(output.Status, complete, output.Error ?? $"Energy result {output.ResultRevision} is ready.", output.ResultRevision);

            Uri? current = _web.Source;
            bool onRevex = current != null && current.AbsoluteUri.Contains("/apps/revex/", StringComparison.OrdinalIgnoreCase);
            if (onRevex)
            {
                var attached = await EngineeringCompanionWebBridge.AttachEnergyResultAsync(_web, output);
                SetStatus(attached.message);
                if (attached.ok) _pendingEnergyResult = null;
            }
            else
            {
                OpenCompanion("energy");
            }
            workflow.Complete(complete, $"status={output.Status}; resultRevision={output.ResultRevision}; artifacts={output.ArtifactPaths.Count}; root={output.RootFolder}");
            if (!complete && !string.IsNullOrWhiteSpace(output.Error)) ShowFailure("Energy package", output.Error);
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("ENERGY", "Automatic Energy pipeline failed.", ex);
            workflow.Complete(false, ex.Message);
            SendEnergyStatus("failed", false, ex.Message);
            ShowFailure("Energy package", ex.Message);
        }
        finally
        {
            _energyPipelineRunning = false;
        }
    }

    // Legacy diagnostic implementation retained for source compatibility only. r31 never calls this method;
    // official Energy execution is server-only after immutable Engineering Sync publication.
    private async Task HandleEnergyRunAsync(JsonElement root)
    {
        string correlationId = ReadString(root, "correlationId", RevexDiagnostics.NewCorrelationId("energy"));
        string initiator = ReadString(root, "initiator", "Companion Energy run button");
        using var workflow = RevexDiagnostics.BeginWorkflow("COMPANION_ENERGY_PACKAGE", initiator, correlationId);
        if (_energyPipelineRunning)
        {
            SendEnergyStatus("busy", false, "An Energy package is already running.");
            workflow.Complete(false, "blocked because another Energy package is active");
            return;
        }
        EngineeringSyncOutput? source = _lastEngineeringSync;
        if (source == null)
        {
            SendEnergyStatus("blocked", false, "Run SYNC ENGINEERING from Revit first.");
            workflow.Complete(false, "blocked because no Engineering Sync source is loaded");
            return;
        }
        string activeProject = _projectId.Text.Trim();
        if (!string.Equals(source.ProjectId, activeProject, StringComparison.Ordinal))
        {
            SendEnergyStatus("blocked", false, "The active Companion project does not match the last Engineering Sync revision.");
            workflow.Complete(false, "blocked because Companion project and Engineering Sync source do not match");
            return;
        }

        var request = new EnergyPipelineRequest
        {
            CorrelationId = correlationId,
            ParentCorrelationId = ReadString(root, "parentCorrelationId", ""),
            Initiator = initiator,
            ProjectId = activeProject,
            ProjectName = ReadString(root, "projectName", ""),
            OpenStudioCli = ReadString(root, "openStudioCli", ""),
            WeatherFilePath = ReadString(root, "weatherFilePath", ""),
            WeatherFileName = ReadString(root, "weatherFileName", ""),
            WeatherDataUrl = ReadString(root, "weatherDataUrl", ""),
            StandardVersion = ReadString(root, "standardVersion", "NYCECC 2020")
        };

        _energyPipelineRunning = true;
        SendEnergyStatus("running", true, "Converting the Revit evidence graph and preparing Baseline/Proposed simulations…");
        SetStatus("Energy pipeline is running outside Revit. The RVT is no longer being accessed.");
        try
        {
            EnergyPipelineOutput output = await new EnergyPipelineService().RunAsync(source, request);
            _pendingEnergyResult = output;
            SendEnergyStatus(output.Status, string.Equals(output.Status, "COMPLETE", StringComparison.OrdinalIgnoreCase),
                output.Error ?? $"Energy result {output.ResultRevision} is ready.", output.ResultRevision);

            Uri? current = _web.Source;
            bool onRevex = current != null && current.AbsoluteUri.Contains("/apps/revex/", StringComparison.OrdinalIgnoreCase);
            if (onRevex)
            {
                var attached = await EngineeringCompanionWebBridge.AttachEnergyResultAsync(_web, output);
                SetStatus(attached.message);
                if (attached.ok) _pendingEnergyResult = null;
            }
            else
            {
                OpenCompanion("energy");
            }
            workflow.Complete(string.Equals(output.Status, "COMPLETE", StringComparison.OrdinalIgnoreCase),
                $"status={output.Status}; resultRevision={output.ResultRevision}; artifacts={output.ArtifactPaths.Count}; root={output.RootFolder}");
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("ENERGY", "Companion Energy pipeline failed.", ex);
            workflow.Complete(false, ex.Message);
            SendEnergyStatus("failed", false, ex.Message);
            ShowFailure("Energy package", ex.Message);
        }
        finally
        {
            _energyPipelineRunning = false;
        }
    }

    private void SendEnergyStatus(string stage, bool ok, string message, string? resultRevision = null)
    {
        if (_web.CoreWebView2 == null) return;
        _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
        {
            type = "liber:revex-energy-status",
            stage,
            ok,
            message,
            resultRevision
        }));
    }

    private void HandleRenderRequest(JsonElement root)
    {
        string renderJobId = ReadString(root, "renderJobId", "");
        string prompt = ReadString(root, "prompt", "");
        JsonElement settings = root.TryGetProperty("settings", out JsonElement value) ? value : default;
        var renderSettings = new RenderSettings
        {
            AutoMaterialIntent = ReadBool(settings, "autoMaterials", true),
            PreserveGeometry = true,
            RealisticOnly = true,
            Environment = ReadString(settings, "environment", "Natural daylight"),
            Staging = ReadString(settings, "staging", "Preserve modeled objects only"),
            People = ReadString(settings, "people", "None"),
            PixelSize = _bridgeSettings.DefaultPixelSize,
            BatchNameContains = _batchToken.Text.Trim()
        };

        _renderAwaitingRevit = true;
        _ = WatchPendingAsync("RENDER CAPTURE", () => _renderAwaitingRevit);
        SetStatus("Capturing the active Revit 3D view for the REVEX Render modal…");
        _handler.Enqueue(new RevitRequest(
            RevitRequestKind.CaptureCurrentView,
            renderSettings,
            result => Dispatcher.BeginInvoke(new Action(async () =>
                await HandleNativeRenderCaptureAsync(result, renderJobId, prompt))))
        {
            CorrelationId = string.IsNullOrWhiteSpace(renderJobId) ? RevexDiagnostics.NewCorrelationId("render") : "render-" + renderJobId,
            Initiator = "Companion Render request"
        });
        _externalEvent.Raise();
    }

    private async Task HandleNativeRenderCaptureAsync(RevitRequestResult result, string renderJobId, string prompt)
    {
        _renderAwaitingRevit = false;
        RevexDiagnostics.Info("RENDER", $"Native render capture callback. success={result.Success}; packages={result.Packages.Count}; {result.Message}");
        if (!result.Success || result.Packages.Count == 0)
        {
            SendRenderStatus(false, renderJobId, result.Message);
            ShowFailure("Render failed", result.Message);
            return;
        }

        TransferPackage package = result.Packages[0];
        _pendingQuickRender = package;
        _pendingQuickPrompt = string.IsNullOrWhiteSpace(prompt)
            ? package.Prompt
            : prompt.Trim() + "\n\nREVEX / Revit context and non-destructive constraints:\n" + package.Prompt;
        _pendingRenderJobId = renderJobId;
        _prompt.Text = prompt ?? "";

        Uri? current = _web.Source;
        if (current == null || !current.Host.EndsWith("rendair.ai", StringComparison.OrdinalIgnoreCase))
        {
            OpenRenderBridge();
            return;
        }
        await ExecutePendingQuickRenderAsync();
    }

    private void SendRenderStatus(bool ok, string renderJobId, string message)
    {
        if (_web.CoreWebView2 == null) return;
        _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
        {
            type = "liber:revex-render-status",
            ok,
            renderJobId,
            message
        }));
    }

    private async Task WatchGbxmlAsync()
    {
        await Task.Delay(30000);
        if (_gbxmlAwaitingRevit)
            RevexDiagnostics.Info("GBXML", "Engineering engine is still running after 30 seconds; geometry analysis can legitimately take several minutes.");
        await Task.Delay(90000);
        if (_gbxmlAwaitingRevit)
            RevexDiagnostics.Warn("GBXML", "Engineering engine is still running after 2 minutes. REVEX is waiting for Dynamo/Revit to finish rather than interrupting the transaction.");
        await Task.Delay(180000);
        if (_gbxmlAwaitingRevit)
            RevexDiagnostics.Error("GBXML", "Engineering engine has had no completion callback for 5 minutes. Review Dynamo/Revit state and the session log.");
    }

    private async Task WatchPendingAsync(string operation, Func<bool> isPending)
    {
        await Task.Delay(8000);
        if (isPending())
            RevexDiagnostics.Warn("WATCHDOG", operation + " has had no Revit callback for 8 seconds. If this is the last line, the ExternalEvent/Revit API stage is blocked or Revit is busy.");
        await Task.Delay(22000);
        if (isPending())
            RevexDiagnostics.Error("WATCHDOG", operation + " has had no Revit callback for 30 seconds.");
    }

    private static string ReadString(JsonElement root, string name, string fallback)
    {
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String)
            return value.GetString() ?? fallback;
        return fallback;
    }

    private static bool ReadBool(JsonElement root, string name, bool fallback)
    {
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out JsonElement value) &&
            (value.ValueKind == JsonValueKind.True || value.ValueKind == JsonValueKind.False))
            return value.GetBoolean();
        return fallback;
    }

    private void ShowFailure(string title, string message)
    {
        string text = string.IsNullOrWhiteSpace(message) ? "Unknown REVEX error." : message.Trim();
        RevexDiagnostics.Error("FAIL", title + ": " + text);
        SetStatus(title + ": " + text);
        // Runtime failures stay non-modal. Diagnostics + status remain usable even
        // when WebView2 or a Revit ExternalEvent is unhealthy.
    }

    private static UIElement EngineeringInfoCard(string kicker, string title, string body)
    {
        var stack = new StackPanel();
        stack.Children.Add(new TextBlock
        {
            Text = kicker,
            FontSize = 9.5,
            FontWeight = FontWeights.SemiBold,
            Opacity = 0.58,
            Margin = new Thickness(0, 0, 0, 4)
        });
        stack.Children.Add(new TextBlock
        {
            Text = title,
            FontSize = 13,
            FontWeight = FontWeights.SemiBold,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 5)
        });
        stack.Children.Add(new TextBlock
        {
            Text = body,
            FontSize = 10.5,
            Opacity = 0.68,
            TextWrapping = TextWrapping.Wrap
        });
        return new Border
        {
            Background = new SolidColorBrush(Color.FromRgb(244, 246, 249)),
            BorderBrush = new SolidColorBrush(Color.FromRgb(218, 223, 230)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(12),
            Margin = new Thickness(0, 4, 0, 8),
            Child = stack
        };
    }

    private static TextBlock SectionTitle(string text) => new()
    {
        Text = text,
        FontWeight = FontWeights.Bold,
        Margin = new Thickness(0, 18, 0, 8),
        Opacity = 0.82
    };

    private static Button MakeButton(string text, RoutedEventHandler handler, bool secondary = false)
    {
        var b = new Button
        {
            Content = text,
            Height = 34,
            Margin = new Thickness(0, 3, 0, 3),
            FontWeight = secondary ? FontWeights.Normal : FontWeights.SemiBold
        };
        b.Click += handler;
        return b;
    }

    private static Button MakeNavButton(string text, RoutedEventHandler handler)
    {
        var b = new Button
        {
            Content = text,
            MinWidth = 60,
            Height = 30,
            Margin = new Thickness(2, 0, 2, 0)
        };
        b.Click += handler;
        return b;
    }

    private static UIElement Labeled(string label, WpfComboBox combo)
    {
        var panel = new StackPanel { Margin = new Thickness(0, 5, 0, 5) };
        panel.Children.Add(new TextBlock { Text = label, FontSize = 11, Opacity = 0.7 });
        combo.Margin = new Thickness(0, 3, 0, 0);
        panel.Children.Add(combo);
        return panel;
    }

    private static UIElement LabeledInput(string label, WpfTextBox input, string help)
    {
        var panel = new StackPanel { Margin = new Thickness(0, 5, 0, 7) };
        panel.Children.Add(new TextBlock { Text = label, FontSize = 11, Opacity = 0.76 });
        input.Margin = new Thickness(0, 3, 0, 2);
        input.MinHeight = 29;
        panel.Children.Add(input);
        panel.Children.Add(new TextBlock
        {
            Text = help,
            FontSize = 10,
            Opacity = 0.55,
            TextWrapping = TextWrapping.Wrap
        });
        return panel;
    }

    private static void PopulateCombo(WpfComboBox combo, IEnumerable<string> values, int selected)
    {
        foreach (string value in values)
            combo.Items.Add(value);
        combo.SelectedIndex = selected;
    }

    private void OpenMaterialRules()
    {
        AppPaths.Ensure();
        string path = Path.Combine(AppPaths.Config, "material-rules.json");
        Process.Start(new ProcessStartInfo
        {
            FileName = path,
            UseShellExecute = true
        });
        SetStatus("Opened material-rules.json. Changes apply on the next capture.");
    }

    private void SetStatus(string message)
    {
        _status.Text = message;
        RevexDiagnostics.Info("STATUS", message);
    }
}
