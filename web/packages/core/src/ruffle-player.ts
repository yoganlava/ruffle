import type { Ruffle } from "../dist/ruffle_web";
import { loadRuffle } from "./load-ruffle";
import { ruffleShadowTemplate } from "./shadow-template";
import { lookupElement } from "./register-element";
import { DEFAULT_CONFIG } from "./config";
import type { DataLoadOptions, URLLoadOptions } from "./load-options";
import { AutoPlay, UnmuteOverlay, WindowMode } from "./load-options";
import type { MovieMetadata } from "./movie-metadata";
import { swfFileName } from "./swf-file-name";
import { buildInfo } from "./build-info";
import {
    FLASH_MIMETYPE,
    FUTURESPLASH_MIMETYPE,
    FLASH7_AND_8_MIMETYPE,
    FLASH_MOVIE_MIMETYPE,
} from "./flash-identifiers";

const RUFFLE_ORIGIN = "https://ruffle.rs";
const DIMENSION_REGEX = /^\s*(\d+(\.\d+)?(%)?)/;

let isAudioContextUnmuted = false;

const enum PanicError {
    Unknown,
    CSPConflict,
    FileProtocol,
    InvalidWasm,
    JavascriptConfiguration,
    JavascriptConflict,
    WasmCors,
    WasmDownload,
    WasmMimeType,
    WasmNotFound,
    WasmDisabledMicrosoftEdge,
    SwfFetchError,
    SwfCors,
}

// Safari still requires prefixed fullscreen APIs, see:
// https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullScreen
// Safari uses alternate capitalization of FullScreen in some older APIs.
declare global {
    interface Document {
        webkitFullscreenEnabled?: boolean;
        webkitFullscreenElement?: boolean;
        webkitExitFullscreen?: () => void;
        webkitCancelFullScreen?: () => void;
    }
    interface Element {
        webkitRequestFullscreen?: (options: unknown) => unknown;
        webkitRequestFullScreen?: (options: unknown) => unknown;
    }
}

/**
 * An item to show in Ruffle's custom context menu.
 */
interface ContextMenuItem {
    /**
     * The text shown to the user.
     */
    text: string;

    /**
     * The function to call when clicked.
     *
     * @param event The mouse event that triggered the click.
     */
    onClick: (event: MouseEvent) => void;

    /**
     * Whether this item is clickable.
     *
     * @default true
     */
    enabled?: boolean;
}

/**
 * Converts arbitrary input to an easy to use record object.
 *
 * @param parameters Parameters to sanitize
 * @returns A sanitized map of param name to param value
 */
function sanitizeParameters(
    parameters:
        | (URLSearchParams | string | Record<string, string>)
        | undefined
        | null
): Record<string, string> {
    if (parameters === null || parameters === undefined) {
        return {};
    }
    if (!(parameters instanceof URLSearchParams)) {
        parameters = new URLSearchParams(parameters);
    }

    const output: Record<string, string> = {};
    for (const [key, value] of parameters) {
        // Every value must be type of string
        output[key] = value.toString();
    }

    return output;
}

/**
 * The ruffle player element that should be inserted onto the page.
 *
 * This element will represent the rendered and intractable flash movie.
 */
export class RufflePlayer extends HTMLElement {
    private readonly shadow: ShadowRoot;
    private readonly dynamicStyles: HTMLStyleElement;
    private readonly container: HTMLElement;
    private readonly playButton: HTMLElement;
    private readonly unmuteOverlay: HTMLElement;
    private readonly splashScreen: HTMLElement;
    private readonly virtualKeyboard: HTMLInputElement;
    private readonly saveManager: HTMLDialogElement;

    // Firefox has a read-only "contextMenu" property,
    // so avoid shadowing it.
    private readonly contextMenuElement: HTMLElement;

    // Allows the user to permanently disable the context menu.
    private contextMenuForceDisabled = false;

    // Whether this device is a touch device.
    // Set to true when a touch event is encountered.
    private isTouch = false;
    // Whether this device sends contextmenu events.
    // Set to true when a contextmenu event is seen.
    private contextMenuSupported = false;

    // The effective config loaded upon `.load()`.
    private loadedConfig?: URLLoadOptions | DataLoadOptions;

    private swfUrl?: URL;
    private instance: Ruffle | null;
    private lastActivePlayingState: boolean;

    private _metadata: MovieMetadata | null;
    private _readyState: ReadyState;

    private panicked = false;
    private _cachedDebugInfo: string | null = null;

    private isExtension = false;
    private longPressTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Triggered when a movie metadata has been loaded (such as movie width and height).
     *
     * @event RufflePlayer#loadedmetadata
     */
    static LOADED_METADATA = "loadedmetadata";

    /**
     * Triggered when a movie is fully loaded.
     *
     * @event RufflePlayer#loadeddata
     */
    static LOADED_DATA = "loadeddata";

    /**
     * A movie can communicate with the hosting page using fscommand
     * as long as script access is allowed.
     *
     * @param command A string passed to the host application for any use.
     * @param args A string passed to the host application for any use.
     * @returns True if the command was handled.
     */
    onFSCommand: ((command: string, args: string) => boolean) | null;

    /**
     * Any configuration that should apply to this specific player.
     * This will be defaulted with any global configuration.
     */
    config: URLLoadOptions | DataLoadOptions | object = {};

    /**
     * Indicates the readiness of the playing movie.
     *
     * @returns The `ReadyState` of the player.
     */
    get readyState(): ReadyState {
        return this._readyState;
    }

    /**
     * The metadata of the playing movie (such as movie width and height).
     * These are inherent properties stored in the SWF file and are not affected by runtime changes.
     * For example, `metadata.width` is the width of the SWF file, and not the width of the Ruffle player.
     *
     * @returns The metadata of the movie, or `null` if the movie metadata has not yet loaded.
     */
    get metadata(): MovieMetadata | null {
        return this._metadata;
    }

    /**
     * Constructs a new Ruffle flash player for insertion onto the page.
     */
    constructor() {
        super();

        this.shadow = this.attachShadow({ mode: "open" });
        this.shadow.appendChild(ruffleShadowTemplate.content.cloneNode(true));

        this.dynamicStyles = <HTMLStyleElement>(
            this.shadow.getElementById("dynamic_styles")
        );
        this.container = this.shadow.getElementById("container")!;
        this.playButton = this.shadow.getElementById("play_button")!;
        this.playButton.addEventListener("click", () => this.play());

        this.unmuteOverlay = this.shadow.getElementById("unmute_overlay")!;
        this.splashScreen = this.shadow.getElementById("splash-screen")!;
        this.virtualKeyboard = <HTMLInputElement>(
            this.shadow.getElementById("virtual-keyboard")!
        );
        this.virtualKeyboard.addEventListener(
            "input",
            this.virtualKeyboardInput.bind(this)
        );
        this.saveManager = <HTMLDialogElement>(
            this.shadow.getElementById("save-manager")!
        );
        this.saveManager.addEventListener("click", () =>
            this.saveManager.close()
        );
        const modalArea = this.saveManager.querySelector("#modal-area");
        if (modalArea) {
            modalArea.addEventListener("click", (event) =>
                event.stopPropagation()
            );
        }
        const closeSaveManager = this.saveManager.querySelector("#close-modal");
        if (closeSaveManager) {
            closeSaveManager.addEventListener("click", () =>
                this.saveManager.close()
            );
        }
        const backupSaves = this.saveManager.querySelector("#backup-saves");
        if (backupSaves) {
            backupSaves.addEventListener("click", this.backupSaves.bind(this));
        }

        this.contextMenuElement = this.shadow.getElementById("context-menu")!;
        window.addEventListener("pointerdown", this.pointerDown.bind(this));
        this.addEventListener("contextmenu", this.showContextMenu.bind(this));
        this.container.addEventListener(
            "pointerdown",
            this.startLongPressTimer.bind(this)
        );
        this.container.addEventListener(
            "pointerup",
            this.checkLongPress.bind(this)
        );
        this.container.addEventListener(
            "pointercancel",
            this.clearLongPressTimer.bind(this)
        );

        this.addEventListener(
            "fullscreenchange",
            this.fullScreenChange.bind(this)
        );
        this.addEventListener(
            "webkitfullscreenchange",
            this.fullScreenChange.bind(this)
        );

        this.instance = null;
        this.onFSCommand = null;

        this._readyState = ReadyState.HaveNothing;
        this._metadata = null;

        this.lastActivePlayingState = false;
        this.setupPauseOnTabHidden();
    }

    /**
     * Setup event listener to detect when tab is not active to pause instance playback.
     * this.instance.play() is called when the tab becomes visible only if the
     * the instance was not paused before tab became hidden.
     *
     * See: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
     * @ignore
     * @internal
     */
    private setupPauseOnTabHidden(): void {
        document.addEventListener(
            "visibilitychange",
            () => {
                if (!this.instance) {
                    return;
                }

                // Tab just changed to be inactive. Record whether instance was playing.
                if (document.hidden) {
                    this.lastActivePlayingState = this.instance.is_playing();
                    this.instance.pause();
                }
                // Play only if instance was playing originally.
                if (!document.hidden && this.lastActivePlayingState === true) {
                    this.instance.play();
                }
            },
            false
        );
    }

    /**
     * @ignore
     * @internal
     */
    connectedCallback(): void {
        this.updateStyles();
    }

    /**
     * @ignore
     * @internal
     */
    static get observedAttributes(): string[] {
        return ["width", "height"];
    }

    /**
     * @ignore
     * @internal
     */
    attributeChangedCallback(
        name: string,
        _oldValue: string | undefined,
        _newValue: string | undefined
    ): void {
        if (name === "width" || name === "height") {
            this.updateStyles();
        }
    }

    /**
     * @ignore
     * @internal
     */
    disconnectedCallback(): void {
        this.destroy();
    }

    /**
     * Updates the internal shadow DOM to reflect any set attributes from
     * this element.
     *
     * @protected
     */
    protected updateStyles(): void {
        if (this.dynamicStyles.sheet) {
            if (this.dynamicStyles.sheet.rules) {
                for (
                    let i = 0;
                    i < this.dynamicStyles.sheet.rules.length;
                    i++
                ) {
                    this.dynamicStyles.sheet.deleteRule(i);
                }
            }

            const widthAttr = this.attributes.getNamedItem("width");
            if (widthAttr !== undefined && widthAttr !== null) {
                const width = RufflePlayer.htmlDimensionToCssDimension(
                    widthAttr.value
                );
                if (width !== null) {
                    this.dynamicStyles.sheet.insertRule(
                        `:host { width: ${width}; }`
                    );
                }
            }

            const heightAttr = this.attributes.getNamedItem("height");
            if (heightAttr !== undefined && heightAttr !== null) {
                const height = RufflePlayer.htmlDimensionToCssDimension(
                    heightAttr.value
                );
                if (height !== null) {
                    this.dynamicStyles.sheet.insertRule(
                        `:host { height: ${height}; }`
                    );
                }
            }
        }
    }

    /**
     * Determine if this element is the fallback content of another Ruffle
     * player.
     *
     * This heuristic assumes Ruffle objects will never use their fallback
     * content. If this changes, then this code also needs to change.
     *
     * @private
     */
    private isUnusedFallbackObject(): boolean {
        const element = lookupElement("ruffle-object");

        if (element !== null) {
            let parent = this.parentNode;
            while (parent !== document && parent !== null) {
                if (parent.nodeName === element.name) {
                    return true;
                }

                parent = parent.parentNode;
            }
        }

        return false;
    }

    /**
     * Ensure a fresh Ruffle instance is ready on this player before continuing.
     *
     * @throws Any exceptions generated by loading Ruffle Core will be logged
     * and passed on.
     *
     * @private
     */
    private async ensureFreshInstance(): Promise<void> {
        this.destroy();

        if (
            this.loadedConfig &&
            this.loadedConfig.splashScreen !== false &&
            this.loadedConfig.preloader !== false
        ) {
            this.showSplashScreen();
        }
        if (this.loadedConfig && this.loadedConfig.preloader === false) {
            console.warn(
                "The configuration option preloader has been replaced with splashScreen. If you own this website, please update the configuration."
            );
        }
        const ruffleConstructor = await loadRuffle(
            this.loadedConfig || {},
            this.onRuffleDownloadProgress.bind(this)
        ).catch((e) => {
            console.error(`Serious error loading Ruffle: ${e}`);

            // Serious duck typing. In error conditions, let's not make assumptions.
            if (window.location.protocol === "file:") {
                e.ruffleIndexError = PanicError.FileProtocol;
            } else {
                e.ruffleIndexError = PanicError.WasmNotFound;
                const message = String(e.message).toLowerCase();
                if (message.includes("mime")) {
                    e.ruffleIndexError = PanicError.WasmMimeType;
                } else if (
                    message.includes("networkerror") ||
                    message.includes("failed to fetch")
                ) {
                    e.ruffleIndexError = PanicError.WasmCors;
                } else if (message.includes("disallowed by embedder")) {
                    e.ruffleIndexError = PanicError.CSPConflict;
                } else if (e.name === "CompileError") {
                    e.ruffleIndexError = PanicError.InvalidWasm;
                } else if (
                    message.includes("could not download wasm module") &&
                    e.name === "TypeError"
                ) {
                    e.ruffleIndexError = PanicError.WasmDownload;
                } else if (e.name === "TypeError") {
                    e.ruffleIndexError = PanicError.JavascriptConflict;
                } else if (
                    navigator.userAgent.includes("Edg") &&
                    message.includes("webassembly is not defined")
                ) {
                    // Microsoft Edge detection.
                    e.ruffleIndexError = PanicError.WasmDisabledMicrosoftEdge;
                }
            }
            this.panic(e);
            throw e;
        });

        this.instance = await new ruffleConstructor(
            this.container,
            this,
            this.loadedConfig
        );
        this._cachedDebugInfo = this.instance!.renderer_debug_info();
        console.log(
            "New Ruffle instance created (WebAssembly extensions: " +
                (ruffleConstructor.is_wasm_simd_used() ? "ON" : "OFF") +
                ")"
        );

        // In Firefox, AudioContext.state is always "suspended" when the object has just been created.
        // It may change by itself to "running" some milliseconds later. So we need to wait a little
        // bit before checking if autoplay is supported and applying the instance config.
        if (this.audioState() !== "running") {
            this.container.style.visibility = "hidden";
            await new Promise<void>((resolve) => {
                window.setTimeout(() => {
                    resolve();
                }, 200);
            });
            this.container.style.visibility = "";
        }

        this.unmuteAudioContext();
        // On Android, the virtual keyboard needs to be dismissed as otherwise it re-focuses when clicking elsewhere
        if (navigator.userAgent.toLowerCase().includes("android")) {
            this.container.addEventListener("click", () =>
                this.virtualKeyboard.blur()
            );
        }

        // Treat invalid values as `AutoPlay.Auto`.
        if (
            !this.loadedConfig ||
            this.loadedConfig.autoplay === AutoPlay.On ||
            (this.loadedConfig.autoplay !== AutoPlay.Off &&
                this.audioState() === "running")
        ) {
            this.play();

            if (this.audioState() !== "running") {
                // Treat invalid values as `UnmuteOverlay.Visible`.
                if (
                    !this.loadedConfig ||
                    this.loadedConfig.unmuteOverlay !== UnmuteOverlay.Hidden
                ) {
                    this.unmuteOverlay.style.display = "block";
                }

                this.container.addEventListener(
                    "click",
                    this.unmuteOverlayClicked.bind(this),
                    {
                        once: true,
                    }
                );

                const audioContext = this.instance?.audio_context();
                if (audioContext) {
                    audioContext.onstatechange = () => {
                        if (audioContext.state === "running") {
                            this.unmuteOverlayClicked();
                        }
                        audioContext.onstatechange = null;
                    };
                }
            }
        } else {
            this.playButton.style.display = "block";
        }
    }

    /**
     * Uploads the splash screen progress bar.
     *
     * @param bytesLoaded The size of the Ruffle WebAssembly file downloaded so far.
     * @param bytesTotal The total size of the Ruffle WebAssembly file.
     */
    private onRuffleDownloadProgress(bytesLoaded: number, bytesTotal: number) {
        const loadBar = <HTMLElement>(
            this.splashScreen.querySelector(".loadbar-inner")
        );
        const outerLoadbar = <HTMLElement>(
            this.splashScreen.querySelector(".loadbar")
        );
        if (Number.isNaN(bytesTotal)) {
            if (outerLoadbar) {
                outerLoadbar.style.display = "none";
            }
        } else {
            loadBar.style.width = `${100.0 * (bytesLoaded / bytesTotal)}%`;
        }
    }

    /**
     * Destroys the currently running instance of Ruffle.
     */
    private destroy(): void {
        if (this.instance) {
            this.instance.destroy();
            this.instance = null;
            this._metadata = null;
            this._readyState = ReadyState.HaveNothing;
            console.log("Ruffle instance destroyed.");
        }
    }

    private checkOptions(
        options: string | URLLoadOptions | DataLoadOptions
    ): URLLoadOptions | DataLoadOptions {
        if (typeof options === "string") {
            return { url: options };
        }

        const check: (
            condition: boolean,
            message: string
        ) => asserts condition = (condition, message) => {
            if (!condition) {
                const error = new TypeError(message);
                error.ruffleIndexError = PanicError.JavascriptConfiguration;
                this.panic(error);
                throw error;
            }
        };
        check(
            options !== null && typeof options === "object",
            "Argument 0 must be a string or object"
        );
        check(
            "url" in options || "data" in options,
            "Argument 0 must contain a `url` or `data` key"
        );
        check(
            !("url" in options) || typeof options.url === "string",
            "`url` must be a string"
        );
        return options;
    }
    /**
     * Gets the configuration set by the Ruffle extension
     *
     * @returns The configuration set by the Ruffle extension
     */
    getExtensionConfig(): Record<string, unknown> {
        return window.RufflePlayer &&
            window.RufflePlayer.conflict &&
            (window.RufflePlayer.conflict["newestName"] === "extension" ||
                (window.RufflePlayer as Record<string, unknown>)[
                    "newestName"
                ] === "extension")
            ? (window.RufflePlayer?.conflict["config"] as Record<
                  string,
                  unknown
              >)
            : {};
    }

    /**
     * Loads a specified movie into this player.
     *
     * This will replace any existing movie that may be playing.
     *
     * @param options One of the following:
     * - A URL, passed as a string, which will load a URL with default options.
     * - A [[URLLoadOptions]] object, to load a URL with options.
     * - A [[DataLoadOptions]] object, to load data with options.
     *
     * The options will be defaulted by the [[config]] field, which itself
     * is defaulted by a global `window.RufflePlayer.config`.
     */
    async load(
        options: string | URLLoadOptions | DataLoadOptions
    ): Promise<void> {
        options = this.checkOptions(options);

        if (!this.isConnected || this.isUnusedFallbackObject()) {
            console.warn(
                "Ignoring attempt to play a disconnected or suspended Ruffle element"
            );
            return;
        }

        if (isFallbackElement(this)) {
            // Silently fail on attempt to play a Ruffle element inside a specific node.
            return;
        }

        try {
            const extensionConfig = this.getExtensionConfig();
            this.loadedConfig = {
                ...DEFAULT_CONFIG,
                ...extensionConfig,
                ...(window.RufflePlayer?.config ?? {}),
                ...this.config,
                ...options,
            };

            // `allowScriptAccess` can only be set in `options`.
            this.loadedConfig.allowScriptAccess =
                options.allowScriptAccess === true;

            // Pre-emptively set background color of container while Ruffle/SWF loads.
            if (
                this.loadedConfig.backgroundColor &&
                this.loadedConfig.wmode !== WindowMode.Transparent
            ) {
                this.container.style.backgroundColor =
                    this.loadedConfig.backgroundColor;
            }

            await this.ensureFreshInstance();

            if ("url" in options) {
                console.log(`Loading SWF file ${options.url}`);
                this.swfUrl = new URL(options.url, document.baseURI);

                const parameters = {
                    ...sanitizeParameters(
                        options.url.substring(options.url.indexOf("?"))
                    ),
                    ...sanitizeParameters(options.parameters),
                };

                this.instance!.stream_from(this.swfUrl.href, parameters);
            } else if ("data" in options) {
                console.log("Loading SWF data");
                this.instance!.load_data(
                    new Uint8Array(options.data),
                    sanitizeParameters(options.parameters),
                    options.swfFileName || "movie.swf"
                );
            }
        } catch (e) {
            console.error(`Serious error occurred loading SWF file: ${e}`);
            const err = new Error(e as string);
            if (err.message.includes("Error parsing config")) {
                err.ruffleIndexError = PanicError.JavascriptConfiguration;
            }
            this.panic(err);
            throw err;
        }
    }

    /**
     * Plays or resumes the movie.
     */
    play(): void {
        if (this.instance) {
            this.instance.play();
            this.playButton.style.display = "none";
        }
    }

    /**
     * Whether this player is currently playing.
     *
     * @returns True if this player is playing, false if it's paused or hasn't started yet.
     */
    get isPlaying(): boolean {
        if (this.instance) {
            return this.instance.is_playing();
        }
        return false;
    }

    /**
     * Returns the master volume of the player.
     *
     * @returns The volume. 1.0 is 100% volume.
     */
    get volume(): number {
        if (this.instance) {
            return this.instance.volume();
        }
        return 1.0;
    }

    /**
     * Sets the master volume of the player.
     *
     * @param value The volume. 1.0 is 100% volume.
     */
    set volume(value: number) {
        if (this.instance) {
            this.instance.set_volume(value);
        }
    }

    /**
     * Checks if this player is allowed to be fullscreen by the browser.
     *
     * @returns True if you may call [[enterFullscreen]].
     */
    get fullscreenEnabled(): boolean {
        return !!(
            document.fullscreenEnabled || document.webkitFullscreenEnabled
        );
    }

    /**
     * Checks if this player is currently fullscreen inside the browser.
     *
     * @returns True if it is fullscreen.
     */
    get isFullscreen(): boolean {
        return (
            (document.fullscreenElement || document.webkitFullscreenElement) ===
            this
        );
    }

    /**
     * Exported function that requests the browser to change the fullscreen state if
     * it is allowed.
     *
     * @param isFull Whether to set to fullscreen or return to normal.
     */
    setFullscreen(isFull: boolean): void {
        if (this.fullscreenEnabled) {
            if (isFull) {
                this.enterFullscreen();
            } else {
                this.exitFullscreen();
            }
        }
    }

    /**
     * Requests the browser to make this player fullscreen.
     *
     * This is not guaranteed to succeed, please check [[fullscreenEnabled]] first.
     */
    enterFullscreen(): void {
        const options: FullscreenOptions = {
            navigationUI: "hide",
        };
        if (this.requestFullscreen) {
            this.requestFullscreen(options);
        } else if (this.webkitRequestFullscreen) {
            this.webkitRequestFullscreen(options);
        } else if (this.webkitRequestFullScreen) {
            this.webkitRequestFullScreen(options);
        }
    }

    /**
     * Requests the browser to no longer make this player fullscreen.
     */
    exitFullscreen(): void {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.webkitCancelFullScreen) {
            document.webkitCancelFullScreen();
        }
    }

    /**
     * Called when entering / leaving fullscreen
     */
    private fullScreenChange(): void {
        this.instance?.set_fullscreen(this.isFullscreen);
    }

    private pointerDown(event: PointerEvent): void {
        if (event.pointerType === "touch" || event.pointerType === "pen") {
            this.isTouch = true;
        }
    }

    private base64ToBlob(bytesBase64: string, mimeString: string): Blob {
        const byteString = atob(bytesBase64);
        const ab = new ArrayBuffer(byteString.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i);
        }
        const blob = new Blob([ab], { type: mimeString });
        return blob;
    }

    /**
     * Download base-64 string as file
     *
     * @param bytesBase64 The base-64 encoded SOL string
     * @param mimeType The MIME type
     * @param fileName The name to give the file
     */
    private saveFile(
        bytesBase64: string,
        mimeType: string,
        fileName: string
    ): void {
        const blob = this.base64ToBlob(bytesBase64, mimeType);
        const blobURL = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = blobURL;
        link.style.display = "none";
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(blobURL);
    }

    /**
     * @returns If the string represent a base-64 encoded SOL file
     * Check if string is a base-64 encoded SOL file
     * @param solData The base-64 encoded SOL string
     */
    private isB64SOL(solData: string): boolean {
        try {
            const decodedData = atob(solData);
            return decodedData.slice(6, 10) === "TCSO";
        } catch (e) {
            return false;
        }
    }

    private confirmReloadSave(
        solKey: string,
        b64SolData: string,
        replace: boolean
    ) {
        if (this.isB64SOL(b64SolData)) {
            if (localStorage[solKey]) {
                if (!replace) {
                    const confirmDelete = confirm(
                        "Are you sure you want to delete this save file?"
                    );
                    if (!confirmDelete) {
                        return;
                    }
                }
                const swfPath = this.swfUrl ? this.swfUrl.pathname : "";
                const swfHost = this.swfUrl
                    ? this.swfUrl.hostname
                    : document.location.hostname;
                const savePath = solKey.split("/").slice(1, -1).join("/");
                if (swfPath.includes(savePath) && solKey.startsWith(swfHost)) {
                    const confirmReload = confirm(
                        `The only way to ${
                            replace ? "replace" : "delete"
                        } this save file without potential conflict is to reload this content. Do you wish to continue anyway?`
                    );
                    if (confirmReload && this.loadedConfig) {
                        this.destroy();
                        replace
                            ? localStorage.setItem(solKey, b64SolData)
                            : localStorage.removeItem(solKey);
                        this.load(this.loadedConfig);
                        this.populateSaves();
                        this.saveManager.close();
                    }
                    return;
                }
                replace
                    ? localStorage.setItem(solKey, b64SolData)
                    : localStorage.removeItem(solKey);
                this.populateSaves();
                this.saveManager.close();
            }
        }
    }

    /**
     * Replace save from SOL file.
     *
     * @param event The change event fired
     * @param solKey The localStorage save file key
     */
    private replaceSOL(event: Event, solKey: string): void {
        const fileInput = <HTMLInputElement>event.target;
        const reader = new FileReader();
        reader.addEventListener("load", () => {
            if (reader.result && typeof reader.result === "string") {
                const b64Regex = new RegExp("data:.*;base64,");
                const b64SolData = reader.result.replace(b64Regex, "");
                this.confirmReloadSave(solKey, b64SolData, true);
            }
        });
        if (
            fileInput &&
            fileInput.files &&
            fileInput.files.length > 0 &&
            fileInput.files[0]
        ) {
            reader.readAsDataURL(fileInput.files[0]);
        }
    }

    /**
     * Delete local save.
     *
     * @param key The key to remove from local storage
     */
    private deleteSave(key: string): void {
        const b64SolData = localStorage.getItem(key);
        if (b64SolData) {
            this.confirmReloadSave(key, b64SolData, false);
        }
    }

    /**
     * Puts the local save SOL file keys in a table.
     */
    private populateSaves(): void {
        const saveTable = this.saveManager.querySelector("#local-saves");
        if (!saveTable) {
            return;
        }
        try {
            localStorage;
        } catch (e: unknown) {
            return;
        }
        saveTable.textContent = "";
        Object.keys(localStorage).forEach((key) => {
            const solName = key.split("/").pop();
            const solData = localStorage.getItem(key);
            if (solName && solData && this.isB64SOL(solData)) {
                const row = document.createElement("TR");
                const keyCol = document.createElement("TD");
                keyCol.textContent = solName;
                keyCol.title = key;
                const downloadCol = document.createElement("TD");
                const downloadSpan = document.createElement("SPAN");
                downloadSpan.textContent = "Download";
                downloadSpan.className = "save-option";
                downloadSpan.addEventListener("click", () =>
                    this.saveFile(
                        solData,
                        "application/octet-stream",
                        solName + ".sol"
                    )
                );
                downloadCol.appendChild(downloadSpan);
                const replaceCol = document.createElement("TD");
                const replaceInput = <HTMLInputElement>(
                    document.createElement("INPUT")
                );
                replaceInput.type = "file";
                replaceInput.accept = ".sol";
                replaceInput.className = "replace-save";
                replaceInput.id = "replace-save-" + key;
                const replaceLabel = <HTMLLabelElement>(
                    document.createElement("LABEL")
                );
                replaceLabel.htmlFor = "replace-save-" + key;
                replaceLabel.textContent = "Replace";
                replaceLabel.className = "save-option";
                replaceInput.addEventListener("change", (event) =>
                    this.replaceSOL(event, key)
                );
                replaceCol.appendChild(replaceInput);
                replaceCol.appendChild(replaceLabel);
                const deleteCol = document.createElement("TD");
                const deleteSpan = document.createElement("SPAN");
                deleteSpan.textContent = "Delete";
                deleteSpan.className = "save-option";
                deleteSpan.addEventListener("click", () =>
                    this.deleteSave(key)
                );
                deleteCol.appendChild(deleteSpan);
                row.appendChild(keyCol);
                row.appendChild(downloadCol);
                row.appendChild(replaceCol);
                row.appendChild(deleteCol);
                saveTable.appendChild(row);
            }
        });
    }

    /**
     * Gets the local save information as SOL files and downloads them.
     */
    private backupSaves(): void {
        Object.keys(localStorage).forEach((key) => {
            const solName = key.split("/").pop();
            const solData = localStorage.getItem(key);
            if (solData && this.isB64SOL(solData)) {
                this.saveFile(
                    solData,
                    "application/octet-stream",
                    solName + ".sol"
                );
            }
        });
    }

    /**
     * Opens the save manager.
     */
    private openSaveManager(): void {
        this.saveManager.showModal();
    }

    /**
     * Fetches the loaded SWF and downloads it.
     */
    async downloadSwf(): Promise<void> {
        try {
            if (this.swfUrl) {
                console.log("Downloading SWF: " + this.swfUrl);
                const response = await fetch(this.swfUrl.href);
                if (!response.ok) {
                    console.error("SWF download failed");
                    return;
                }
                const blob = await response.blob();
                const blobUrl = URL.createObjectURL(blob);
                const swfDownloadA = document.createElement("a");
                swfDownloadA.style.display = "none";
                swfDownloadA.href = blobUrl;
                swfDownloadA.download = swfFileName(this.swfUrl);
                document.body.appendChild(swfDownloadA);
                swfDownloadA.click();
                document.body.removeChild(swfDownloadA);
                URL.revokeObjectURL(blobUrl);
            } else {
                console.error("SWF download failed");
            }
        } catch (err) {
            console.error("SWF download failed");
        }
    }
    private virtualKeyboardInput() {
        const input = this.virtualKeyboard;
        const string = input.value;
        for (const char of string) {
            for (const eventType of ["keydown", "keyup"]) {
                this.dispatchEvent(
                    new KeyboardEvent(eventType, {
                        key: char,
                        bubbles: true,
                    })
                );
            }
        }
        input.value = "";
    }
    protected openVirtualKeyboard(): void {
        // On Android, the Rust code that opens the virtual keyboard triggers
        // before the TypeScript code that closes it, so delay opening it
        if (navigator.userAgent.toLowerCase().includes("android")) {
            setTimeout(() => {
                this.virtualKeyboard.focus({ preventScroll: true });
            }, 100);
        } else {
            this.virtualKeyboard.focus({ preventScroll: true });
        }
    }

    private contextMenuItems(): Array<ContextMenuItem | null> {
        const CHECKMARK = String.fromCharCode(0x2713);
        const items = [];

        if (this.instance) {
            const customItems: {
                readonly caption: string;
                readonly checked: boolean;
                readonly enabled: boolean;
                readonly separatorBefore: boolean;
            }[] = this.instance.prepare_context_menu();
            customItems.forEach((item, index) => {
                // Don't start with separators.
                if (item.separatorBefore && items.length > 0) {
                    items.push(null);
                }
                items.push({
                    // TODO: better checkboxes
                    text:
                        item.caption + (item.checked ? ` (${CHECKMARK})` : ``),
                    onClick: () =>
                        this.instance?.run_context_menu_callback(index),
                    enabled: item.enabled,
                });
            });

            // Don't start with separators.
            if (items.length > 0) {
                items.push(null);
            }
        }

        if (this.fullscreenEnabled) {
            if (this.isFullscreen) {
                items.push({
                    text: "Exit fullscreen",
                    onClick: () => this.instance?.set_fullscreen(false),
                });
            } else {
                items.push({
                    text: "Enter fullscreen",
                    onClick: () => this.instance?.set_fullscreen(true),
                });
            }
        }

        if (
            this.instance &&
            this.swfUrl &&
            this.loadedConfig &&
            this.loadedConfig.showSwfDownload === true
        ) {
            items.push(null);
            items.push({
                text: "Download .swf",
                onClick: this.downloadSwf.bind(this),
            });
        }

        if (window.isSecureContext) {
            items.push({
                text: "Copy debug info",
                onClick: () =>
                    navigator.clipboard.writeText(this.getPanicData()),
            });
        }
        this.populateSaves();
        const localSaveTable = this.saveManager.querySelector("#local-saves");
        if (localSaveTable && localSaveTable.textContent !== "") {
            items.push({
                text: "Open Save Manager",
                onClick: this.openSaveManager.bind(this),
            });
        }

        items.push(null);

        const extensionString = this.isExtension ? "extension" : "";
        items.push({
            text: `About Ruffle ${extensionString} (${buildInfo.versionName})`,
            onClick() {
                window.open(RUFFLE_ORIGIN, "_blank");
            },
        });
        // Give option to disable context menu when touch support is being used
        // to avoid a long press triggering the context menu. (#1972)
        if (this.isTouch) {
            items.push(null);
            items.push({
                text: "Hide this menu",
                onClick: () => (this.contextMenuForceDisabled = true),
            });
        }
        return items;
    }

    private clearLongPressTimer(): void {
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
    }

    private startLongPressTimer(): void {
        const longPressTimeout = 800;
        this.clearLongPressTimer();
        this.longPressTimer = setTimeout(
            () => this.clearLongPressTimer(),
            longPressTimeout
        );
    }

    private checkLongPress(event: PointerEvent): void {
        if (this.longPressTimer) {
            this.clearLongPressTimer();
            // The pointerType condition is to ensure right-click does not trigger
            // a context menu the wrong way the first time you right-click,
            // before contextMenuSupported is set.
        } else if (
            !this.contextMenuSupported &&
            event.pointerType !== "mouse"
        ) {
            this.showContextMenu(event);
        }
    }

    private showContextMenu(event: MouseEvent | PointerEvent): void {
        event.preventDefault();

        if (event.type === "contextmenu") {
            this.contextMenuSupported = true;
            window.addEventListener("click", this.hideContextMenu.bind(this), {
                once: true,
            });
        } else {
            window.addEventListener(
                "pointerup",
                this.hideContextMenu.bind(this),
                { once: true }
            );
            event.stopPropagation();
        }

        if (
            (this.loadedConfig && this.loadedConfig.contextMenu === false) ||
            this.contextMenuForceDisabled
        ) {
            return;
        }

        // Clear all context menu items.
        while (this.contextMenuElement.firstChild) {
            this.contextMenuElement.removeChild(
                this.contextMenuElement.firstChild
            );
        }

        // Populate context menu items.
        for (const item of this.contextMenuItems()) {
            if (item === null) {
                const menuSeparator = document.createElement("li");
                menuSeparator.className = "menu_separator";
                const hr = document.createElement("hr");
                menuSeparator.appendChild(hr);
                this.contextMenuElement.appendChild(menuSeparator);
            } else {
                const { text, onClick, enabled } = item;
                const menuItem = document.createElement("li");
                menuItem.className = "menu_item";
                menuItem.textContent = text;
                this.contextMenuElement.appendChild(menuItem);

                if (enabled !== false) {
                    menuItem.addEventListener(
                        this.contextMenuSupported ? "click" : "pointerup",
                        onClick
                    );
                } else {
                    menuItem.classList.add("disabled");
                }
            }
        }

        // Place a context menu in the top-left corner, so
        // its `clientWidth` and `clientHeight` are not clamped.
        this.contextMenuElement.style.left = "0";
        this.contextMenuElement.style.top = "0";
        this.contextMenuElement.style.display = "block";

        const rect = this.getBoundingClientRect();
        const x = event.clientX - rect.x;
        const y = event.clientY - rect.y;
        const maxX = rect.width - this.contextMenuElement.clientWidth - 1;
        const maxY = rect.height - this.contextMenuElement.clientHeight - 1;

        this.contextMenuElement.style.left =
            Math.floor(Math.min(x, maxX)) + "px";
        this.contextMenuElement.style.top =
            Math.floor(Math.min(y, maxY)) + "px";
    }

    private hideContextMenu(): void {
        this.instance?.clear_custom_menu_items();
        this.contextMenuElement.style.display = "none";
    }

    /**
     * Pauses this player.
     *
     * No more frames, scripts or sounds will be executed.
     * This movie will be considered inactive and will not wake up until resumed.
     */
    pause(): void {
        if (this.instance) {
            this.instance.pause();
            this.playButton.style.display = "block";
        }
    }

    private audioState(): string {
        if (this.instance) {
            const audioContext = this.instance.audio_context();
            return (audioContext && audioContext.state) || "running";
        }
        return "suspended";
    }

    private unmuteOverlayClicked(): void {
        if (this.instance) {
            if (this.audioState() !== "running") {
                const audioContext = this.instance.audio_context();
                if (audioContext) {
                    audioContext.resume();
                }
            }
            this.unmuteOverlay.style.display = "none";
        }
    }

    /**
     * Plays a silent sound based on the AudioContext's sample rate.
     *
     * This is used to unmute audio on iOS and iPadOS when silent mode is enabled on the device (issue 1552).
     */
    private unmuteAudioContext(): void {
        // No need to play the dummy sound again once audio is unmuted.
        if (isAudioContextUnmuted) {
            return;
        }

        // TODO: Use `navigator.userAgentData` to detect the platform when support improves?
        if (navigator.maxTouchPoints < 1) {
            isAudioContextUnmuted = true;
            return;
        }

        this.container.addEventListener(
            "click",
            () => {
                if (isAudioContextUnmuted) {
                    return;
                }

                const audioContext = this.instance?.audio_context();
                if (!audioContext) {
                    return;
                }

                const audio = new Audio();
                audio.src = (() => {
                    // Returns a seven samples long 8 bit mono WAVE file.
                    // This is required to prevent the AudioContext from desyncing and crashing.
                    const arrayBuffer = new ArrayBuffer(10);
                    const dataView = new DataView(arrayBuffer);
                    const sampleRate = audioContext.sampleRate;
                    dataView.setUint32(0, sampleRate, true);
                    dataView.setUint32(4, sampleRate, true);
                    dataView.setUint16(8, 1, true);
                    const missingCharacters = window
                        .btoa(
                            String.fromCharCode(...new Uint8Array(arrayBuffer))
                        )
                        .slice(0, 13);
                    return `data:audio/wav;base64,UklGRisAAABXQVZFZm10IBAAAAABAAEA${missingCharacters}AgAZGF0YQcAAACAgICAgICAAAA=`;
                })();

                audio.load();
                audio
                    .play()
                    .then(() => {
                        isAudioContextUnmuted = true;
                    })
                    .catch((err) => {
                        console.warn(`Failed to play dummy sound: ${err}`);
                    });
            },
            { once: true }
        );
    }

    /**
     * Copies attributes and children from another element to this player element.
     * Used by the polyfill elements, RuffleObject and RuffleEmbed.
     *
     * @param element The element to copy all attributes from.
     * @protected
     */
    protected copyElement(element: Element): void {
        if (element) {
            for (const attribute of element.attributes) {
                if (attribute.specified) {
                    // Issue 468: Chrome "Click to Active Flash" box stomps on title attribute
                    if (
                        attribute.name === "title" &&
                        attribute.value === "Adobe Flash Player"
                    ) {
                        continue;
                    }

                    try {
                        this.setAttribute(attribute.name, attribute.value);
                    } catch (err) {
                        // The embed may have invalid attributes, so handle these gracefully.
                        console.warn(
                            `Unable to set attribute ${attribute.name} on Ruffle instance`
                        );
                    }
                }
            }

            for (const node of Array.from(element.children)) {
                this.appendChild(node);
            }
        }
    }

    /**
     * Converts a dimension attribute on an HTML embed/object element to a valid CSS dimension.
     * HTML element dimensions are unitless, but can also be percentages.
     * Add a 'px' unit unless the value is a percentage.
     * Returns null if this is not a valid dimension.
     *
     * @param attribute The attribute to convert
     *
     * @private
     */
    private static htmlDimensionToCssDimension(
        attribute: string
    ): string | null {
        if (attribute) {
            const match = attribute.match(DIMENSION_REGEX);
            if (match) {
                let out = match[1]!;
                if (!match[3]) {
                    // Unitless -- add px for CSS.
                    out += "px";
                }
                return out;
            }
        }
        return null;
    }

    /**
     * When a movie presents a new callback through `ExternalInterface.addCallback`,
     * we are informed so that we can expose the method on any relevant DOM element.
     *
     * This should only be called by Ruffle itself and not by users.
     *
     * @param name The name of the callback that is now available.
     *
     * @internal
     * @ignore
     */
    protected onCallbackAvailable(name: string): void {
        const instance = this.instance;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (<any>this)[name] = (...args: unknown[]) => {
            return instance?.call_exposed_callback(name, args);
        };
    }

    /**
     * Sets a trace observer on this flash player.
     *
     * The observer will be called, as a function, for each message that the playing movie will "trace" (output).
     *
     * @param observer The observer that will be called for each trace.
     */
    set traceObserver(observer: ((message: string) => void) | null) {
        this.instance?.set_trace_observer(observer);
    }

    /**
     * Get data included in any panic of this ruffle-player
     *
     * @returns A string containing all the data included in the panic.
     */
    private getPanicData(): string {
        const dataArray = [];
        dataArray.push("\n# Player Info\n");
        dataArray.push(this.debugPlayerInfo());

        dataArray.push("\n# Page Info\n");
        dataArray.push(`Page URL: ${document.location.href}\n`);
        if (this.swfUrl) {
            dataArray.push(`SWF URL: ${this.swfUrl}\n`);
        }

        dataArray.push("\n# Browser Info\n");
        dataArray.push(`User Agent: ${window.navigator.userAgent}\n`);
        dataArray.push(`Platform: ${window.navigator.platform}\n`);
        dataArray.push(
            `Has touch support: ${window.navigator.maxTouchPoints > 0}\n`
        );

        dataArray.push("\n# Ruffle Info\n");
        dataArray.push(`Version: ${buildInfo.versionNumber}\n`);
        dataArray.push(`Name: ${buildInfo.versionName}\n`);
        dataArray.push(`Channel: ${buildInfo.versionChannel}\n`);
        dataArray.push(`Built: ${buildInfo.buildDate}\n`);
        dataArray.push(`Commit: ${buildInfo.commitHash}\n`);
        dataArray.push(`Is extension: ${this.isExtension}\n`);
        dataArray.push("\n# Metadata\n");
        if (this.metadata) {
            for (const [key, value] of Object.entries(this.metadata)) {
                dataArray.push(`${key}: ${value}\n`);
            }
        }
        return dataArray.join("");
    }

    /**
     * Panics this specific player, forcefully destroying all resources and displays an error message to the user.
     *
     * This should be called when something went absolutely, incredibly and disastrously wrong and there is no chance
     * of recovery.
     *
     * Ruffle will attempt to isolate all damage to this specific player instance, but no guarantees can be made if there
     * was a core issue which triggered the panic. If Ruffle is unable to isolate the cause to a specific player, then
     * all players will panic and Ruffle will become "poisoned" - no more players will run on this page until it is
     * reloaded fresh.
     *
     * @param error The error, if any, that triggered this panic.
     */
    protected panic(error: Error | null): void {
        if (this.panicked) {
            // Only show the first major error, not any repeats - they aren't as important
            return;
        }
        this.panicked = true;
        this.hideSplashScreen();

        if (
            error instanceof Error &&
            (error.name === "AbortError" ||
                error.message.includes("AbortError"))
        ) {
            // Firefox: Don't display the panic screen if the user leaves the page while something is still loading
            return;
        }

        const errorIndex = error?.ruffleIndexError ?? PanicError.Unknown;

        const errorArray: Array<string | null> & {
            stackIndex: number;
            avmStackIndex: number;
        } = Object.assign([], {
            stackIndex: -1,
            avmStackIndex: -1,
        });

        errorArray.push("# Error Info\n");

        if (error instanceof Error) {
            errorArray.push(`Error name: ${error.name}\n`);
            errorArray.push(`Error message: ${error.message}\n`);
            if (error.stack) {
                const stackIndex =
                    errorArray.push(
                        `Error stack:\n\`\`\`\n${error.stack}\n\`\`\`\n`
                    ) - 1;
                if (error.avmStack) {
                    const avmStackIndex =
                        errorArray.push(
                            `AVM2 stack:\n\`\`\`\n    ${error.avmStack
                                .trim()
                                .replace(/\t/g, "    ")}\n\`\`\`\n`
                        ) - 1;
                    errorArray.avmStackIndex = avmStackIndex;
                }
                errorArray.stackIndex = stackIndex;
            }
        } else {
            errorArray.push(`Error: ${error}\n`);
        }

        errorArray.push(this.getPanicData());

        const errorText = errorArray.join("");

        const buildDate = new Date(buildInfo.buildDate);
        const monthsPrior = new Date();
        monthsPrior.setMonth(monthsPrior.getMonth() - 6); // 6 months prior
        const isBuildOutdated = monthsPrior > buildDate;

        // Create a link to GitHub with all of the error data, if the build is not outdated.
        // Otherwise, create a link to the downloads section on the Ruffle website.
        let actionTag;
        if (!isBuildOutdated) {
            // Remove query params for the issue title.
            const pageUrl = document.location.href.split(/[?#]/)[0];
            const issueTitle = `Error on ${pageUrl}`;
            let issueLink = `https://github.com/ruffle-rs/ruffle/issues/new?title=${encodeURIComponent(
                issueTitle
            )}&template=error_report.md&labels=error-report&body=`;
            let issueBody = encodeURIComponent(errorText);
            if (
                errorArray.stackIndex > -1 &&
                String(issueLink + issueBody).length > 8195
            ) {
                // Strip the stack error from the array when the produced URL is way too long.
                // This should prevent "414 Request-URI Too Large" errors on GitHub.
                errorArray[errorArray.stackIndex] = null;
                if (errorArray.avmStackIndex > -1) {
                    errorArray[errorArray.avmStackIndex] = null;
                }
                issueBody = encodeURIComponent(errorArray.join(""));
            }
            issueLink += issueBody;
            actionTag = `<a target="_top" href="${issueLink}">Report Bug</a>`;
        } else {
            actionTag = `<a target="_top" href="${RUFFLE_ORIGIN}#downloads">Update Ruffle</a>`;
        }

        // Clears out any existing content (ie play button or canvas) and replaces it with the error screen
        let errorBody, errorFooter;
        switch (errorIndex) {
            case PanicError.FileProtocol:
                // General error: Running on the `file:` protocol
                errorBody = `
                    <p>It appears you are running Ruffle on the "file:" protocol.</p>
                    <p>This doesn't work as browsers block many features from working for security reasons.</p>
                    <p>Instead, we invite you to setup a local server or either use the web demo or the desktop application.</p>
                `;
                errorFooter = `
                    <li><a target="_top" href="${RUFFLE_ORIGIN}/demo">Web Demo</a></li>
                    <li><a target="_top" href="${RUFFLE_ORIGIN}#downloads">Desktop Application</a></li>
                `;
                break;
            case PanicError.JavascriptConfiguration:
                // General error: Incorrect JavaScript configuration
                errorBody = `
                    <p>Ruffle has encountered a major issue due to an incorrect JavaScript configuration.</p>
                    <p>If you are the server administrator, we invite you to check the error details to find out which parameter is at fault.</p>
                    <p>You can also consult the Ruffle wiki for help.</p>
                `;
                errorFooter = `
                    <li><a target="_top" href="https://github.com/ruffle-rs/ruffle/wiki/Using-Ruffle#javascript-api">View Ruffle Wiki</a></li>
                    <li><a href="#" id="panic-view-details">View Error Details</a></li>
                `;
                break;
            case PanicError.WasmNotFound:
                // Self hosted: Cannot load `.wasm` file - file not found
                errorBody = `
                    <p>Ruffle failed to load the required ".wasm" file component.</p>
                    <p>If you are the server administrator, please ensure the file has correctly been uploaded.</p>
                    <p>If the issue persists, you may need to use the "publicPath" setting: please consult the Ruffle wiki for help.</p>
                `;
                errorFooter = `
                    <li><a target="_top" href="https://github.com/ruffle-rs/ruffle/wiki/Using-Ruffle#configuration-options">View Ruffle Wiki</a></li>
                    <li><a href="#" id="panic-view-details">View Error Details</a></li>
                `;
                break;
            case PanicError.WasmMimeType:
                // Self hosted: Cannot load `.wasm` file - incorrect MIME type
                errorBody = `
                    <p>Ruffle has encountered a major issue whilst trying to initialize.</p>
                    <p>This web server is not serving ".wasm" files with the correct MIME type.</p>
                    <p>If you are the server administrator, please consult the Ruffle wiki for help.</p>
                `;
                errorFooter = `
                    <li><a target="_top" href="https://github.com/ruffle-rs/ruffle/wiki/Using-Ruffle#configure-webassembly-mime-type">View Ruffle Wiki</a></li>
                    <li><a href="#" id="panic-view-details">View Error Details</a></li>
                `;
                break;
            case PanicError.SwfFetchError:
                errorBody = `
                    <p>Ruffle failed to load the Flash SWF file.</p>
                    <p>The most likely reason is that the file no longer exists, so there is nothing for Ruffle to load.</p>
                    <p>Try contacting the website administrator for help.</p>
                `;
                errorFooter = `
                    <li><a href="#" id="panic-view-details">View Error Details</a></li>
                `;
                break;
            case PanicError.SwfCors:
                // Self hosted: Cannot load SWF file - CORS issues
                errorBody = `
                    <p>Ruffle failed to load the Flash SWF file.</p>
                    <p>Access to fetch has likely been blocked by CORS policy.</p>
                    <p>If you are the server administrator, please consult the Ruffle wiki for help.</p>
                `;
                errorFooter = `
                    <li><a target="_top" href="https://github.com/ruffle-rs/ruffle/wiki/Using-Ruffle#configure-cors-header">View Ruffle Wiki</a></li>
                    <li><a href="#" id="panic-view-details">View Error Details</a></li>
                `;
                break;
            case PanicError.WasmCors:
                // Self hosted: Cannot load `.wasm` file - CORS issues
                errorBody = `
                    <p>Ruffle failed to load the required ".wasm" file component.</p>
                    <p>Access to fetch has likely been blocked by CORS policy.</p>
                    <p>If you are the server administrator, please consult the Ruffle wiki for help.</p>
                `;
                errorFooter = `
                    <li><a target="_top" href="https://github.com/ruffle-rs/ruffle/wiki/Using-Ruffle#configure-cors-header">View Ruffle Wiki</a></li>
                    <li><a href="#" id="panic-view-details">View Error Details</a></li>
                `;
                break;
            case PanicError.InvalidWasm:
                // Self hosted: Cannot load `.wasm` file - incorrect configuration or missing files
                errorBody = `
                    <p>Ruffle has encountered a major issue whilst trying to initialize.</p>
                    <p>It seems like this page has missing or invalid files for running Ruffle.</p>
                    <p>If you are the server administrator, please consult the Ruffle wiki for help.</p>
                `;
                errorFooter = `
                    <li><a target="_top" href="https://github.com/ruffle-rs/ruffle/wiki/Using-Ruffle#addressing-a-compileerror">View Ruffle Wiki</a></li>
                    <li><a href="#" id="panic-view-details">View Error Details</a></li>
                `;
                break;
            case PanicError.WasmDownload:
                // Usually a transient network error or botched deployment
                errorBody = `
                    <p>Ruffle has encountered a major issue whilst trying to initialize.</p>
                    <p>This can often resolve itself, so you can try reloading the page.</p>
                    <p>Otherwise, please contact the website administrator.</p>
                `;
                errorFooter = `
                    <li><a href="#" id="panic-view-details">View Error Details</a></li>
                `;
                break;
            case PanicError.WasmDisabledMicrosoftEdge:
                // Self hosted: User has disabled WebAssembly in Microsoft Edge through the
                // "Enhance your Security on the web" setting.
                errorBody = `
                    <p>Ruffle failed to load the required ".wasm" file component.</p>
                    <p>To fix this, try opening your browser's settings, clicking "Privacy, search, and services", scrolling down, and turning off "Enhance your security on the web".</p>
                    <p>This will allow your browser to load the required ".wasm" files.</p>
                    <p>If the issue persists, you might have to use a different browser.</p>
                `;
                errorFooter = `
                    <li><a target="_top" href="https://github.com/ruffle-rs/ruffle/wiki/Frequently-Asked-Questions-For-Users#edge-webassembly-error">More Information</a></li>
                    <li><a href="#" id="panic-view-details">View Error Details</a></li>
                `;
                break;
            case PanicError.JavascriptConflict:
                // Self hosted: Cannot load `.wasm` file - a native object / function is overriden
                errorBody = `
                    <p>Ruffle has encountered a major issue whilst trying to initialize.</p>
                    <p>It seems like this page uses JavaScript code that conflicts with Ruffle.</p>
                    <p>If you are the server administrator, we invite you to try loading the file on a blank page.</p>
                `;
                if (isBuildOutdated) {
                    errorBody += `<p>You can also try to upload a more recent version of Ruffle that may circumvent the issue (current build is outdated: ${buildInfo.buildDate}).</p>`;
                }
                errorFooter = `
                    <li>${actionTag}</li>
                    <li><a href="#" id="panic-view-details">View Error Details</a></li>
                `;
                break;
            case PanicError.CSPConflict:
                // General error: Cannot load `.wasm` file - a native object / function is overriden
                errorBody = `
                    <p>Ruffle has encountered a major issue whilst trying to initialize.</p>
                    <p>This web server's Content Security Policy does not allow the required ".wasm" component to run.</p>
                    <p>If you are the server administrator, please consult the Ruffle wiki for help.</p>
                `;
                errorFooter = `
                    <li><a target="_top" href="https://github.com/ruffle-rs/ruffle/wiki/Using-Ruffle#configure-wasm-csp">View Ruffle Wiki</a></li>
                    <li><a href="#" id="panic-view-details">View Error Details</a></li>
                `;
                break;
            default:
                // Unknown error
                errorBody = `<p>Ruffle has encountered a major issue whilst trying to display this Flash content.</p>`;
                if (!isBuildOutdated) {
                    errorBody += `<p>This isn't supposed to happen, so we'd really appreciate if you could file a bug!</p>`;
                } else {
                    errorBody += `<p>If you are the server administrator, please try to upload a more recent version of Ruffle (current build is outdated: ${buildInfo.buildDate}).</p>`;
                }
                errorFooter = `
                    <li>${actionTag}</li>
                    <li><a href="#" id="panic-view-details">View Error Details</a></li>
                `;
                break;
        }
        this.container.innerHTML = `
            <div id="panic">
                <div id="panic-title">Something went wrong :(</div>
                <div id="panic-body">${errorBody}</div>
                <div id="panic-footer">
                    <ul>${errorFooter}</ul>
                </div>
            </div>
        `;
        const viewDetails = <HTMLLinkElement>(
            this.container.querySelector("#panic-view-details")
        );
        if (viewDetails) {
            viewDetails.onclick = () => {
                const panicBody = <HTMLDivElement>(
                    this.container.querySelector("#panic-body")
                );
                panicBody.classList.add("details");
                panicBody.innerHTML = `<textarea>${errorText}</textarea>`;
                return false;
            };
        }

        // Do this last, just in case it causes any cascading issues.
        this.destroy();
    }

    protected displayRootMovieDownloadFailedMessage(): void {
        if (
            this.isExtension &&
            window.location.origin !== this.swfUrl!.origin
        ) {
            this.hideSplashScreen();
            const div = document.createElement("div");
            div.id = "message_overlay";
            div.innerHTML = `<div class="message">
                <p>Ruffle wasn't able to run the Flash embedded in this page.</p>
                <p>You can try to open the file in a separate tab, to sidestep this issue.</p>
                <div>
                    <a target="_blank" href="${this.swfUrl}">Open in a new tab</a>
                </div>
            </div>`;
            this.container.prepend(div);
        } else {
            const error = new Error("Failed to fetch: " + this.swfUrl);
            if (!this.swfUrl!.protocol.includes("http")) {
                error.ruffleIndexError = PanicError.FileProtocol;
            } else if (window.location.origin === this.swfUrl!.origin) {
                error.ruffleIndexError = PanicError.SwfFetchError;
            } else {
                // This is a selfhosted build of Ruffle that tried to make a cross-origin request
                error.ruffleIndexError = PanicError.SwfCors;
            }
            this.panic(error);
        }
    }

    protected displayUnsupportedMessage(): void {
        const div = document.createElement("div");
        div.id = "message_overlay";
        // TODO: Change link to https://ruffle.rs/faq or similar
        // TODO: Pause content until message is dismissed
        div.innerHTML = `<div class="message">
            <p>The Ruffle emulator may not yet fully support all of ActionScript 3 used by this content.</p>
            <p>Some parts of the content may not work as expected.</p>
            <div>
                <a target="_blank" class="more-info-link" href="https://github.com/ruffle-rs/ruffle/wiki/Frequently-Asked-Questions-For-Users">More info</a>
                <button id="run-anyway-btn">Run anyway</button>
            </div>
        </div>`;
        this.container.prepend(div);
        const button = <HTMLButtonElement>div.querySelector("#run-anyway-btn");
        button.onclick = () => {
            div.parentNode!.removeChild(div);
        };
    }

    /**
     * Show a dismissible message in front of the player.
     *
     * @param message The message shown to the user.
     */
    protected displayMessage(message: string): void {
        const div = document.createElement("div");
        div.id = "message_overlay";
        div.innerHTML = `<div class="message">
            <p>${message}</p>
            <div>
                <button id="continue-btn">continue</button>
            </div>
        </div>`;
        this.container.prepend(div);
        (<HTMLButtonElement>(
            this.container.querySelector("#continue-btn")
        )).onclick = () => {
            div.parentNode!.removeChild(div);
        };
    }

    protected debugPlayerInfo(): string {
        let result = `Allows script access: ${
            this.loadedConfig ? this.loadedConfig.allowScriptAccess : false
        }\n`;
        let renderInfo = `(Cached) ${this._cachedDebugInfo}`;
        if (this.instance) {
            try {
                renderInfo = this.instance.renderer_debug_info();
            } catch {
                // ignored
            }
        }
        if (renderInfo) {
            result += `${renderInfo}\n`;
        }
        return result;
    }

    private hideSplashScreen(): void {
        this.splashScreen.classList.add("hidden");
        this.container.classList.remove("hidden");
    }

    private showSplashScreen(): void {
        this.splashScreen.classList.remove("hidden");
        this.container.classList.add("hidden");
    }

    protected setMetadata(metadata: MovieMetadata) {
        this._metadata = metadata;
        // TODO: Switch this to ReadyState.Loading when we have streaming support.
        this._readyState = ReadyState.Loaded;
        this.hideSplashScreen();
        this.dispatchEvent(new Event(RufflePlayer.LOADED_METADATA));
        // TODO: Move this to whatever function changes the ReadyState to Loaded when we have streaming support.
        this.dispatchEvent(new Event(RufflePlayer.LOADED_DATA));
    }

    setIsExtension(isExtension: boolean): void {
        this.isExtension = isExtension;
    }
}

/**
 * Describes the loading state of an SWF movie.
 */
export const enum ReadyState {
    /**
     * No movie is loaded, or no information is yet available about the movie.
     */
    HaveNothing = 0,

    /**
     * The movie is still loading, but it has started playback, and metadata is available.
     */
    Loading = 1,

    /**
     * The movie has completely loaded.
     */
    Loaded = 2,
}

/**
 * Returns whether a SWF file can call JavaScript code in the surrounding HTML file.
 *
 * @param access The value of the `allowScriptAccess` attribute.
 * @param url The URL of the SWF file.
 * @returns True if script access is allowed.
 */
export function isScriptAccessAllowed(
    access: string | null,
    url: string
): boolean {
    if (!access) {
        access = "sameDomain";
    }
    switch (access.toLowerCase()) {
        case "always":
            return true;
        case "never":
            return false;
        case "samedomain":
        default:
            try {
                return (
                    new URL(window.location.href).origin ===
                    new URL(url, window.location.href).origin
                );
            } catch {
                return false;
            }
    }
}

/**
 * Returns whether a SWF file should show the built-in context menu items.
 *
 * @param menu The value of the `menu` attribute.
 * @returns True if the built-in context items should be shown.
 */
export function isBuiltInContextMenuVisible(menu: string | null): boolean {
    if (menu === null || menu.toLowerCase() === "true") {
        return true;
    }
    return false;
}

/**
 * Returns whether the given filename is a Youtube Flash source.
 *
 * @param filename The filename to test.
 * @returns True if the filename is a Youtube Flash source.
 */
export function isYoutubeFlashSource(filename: string | null): boolean {
    if (filename) {
        let pathname = "";
        let cleaned_hostname = "";
        try {
            // A base URL is required if `filename` is a relative URL, but we don't need to detect the real URL origin.
            const url = new URL(filename, RUFFLE_ORIGIN);
            pathname = url.pathname;
            cleaned_hostname = url.hostname.replace("www.", "");
        } catch (err) {
            // Some invalid filenames, like `///`, could raise a TypeError. Let's fail silently in this situation.
        }
        // See https://wiki.mozilla.org/QA/Youtube_Embedded_Rewrite
        if (
            pathname.startsWith("/v/") &&
            (cleaned_hostname === "youtube.com" ||
                cleaned_hostname === "youtube-nocookie.com")
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Workaround Youtube mixed content if upgradeToHttps is true.
 *
 * @param elem The element to change.
 * @param attr The attribute to adjust.
 */
export function workaroundYoutubeMixedContent(
    elem: Element,
    attr: string
): void {
    const elem_attr = elem.getAttribute(attr);
    const window_config = window.RufflePlayer?.config ?? {};
    if (elem_attr) {
        try {
            const url = new URL(elem_attr);
            if (
                url.protocol === "http:" &&
                window.location.protocol === "https:" &&
                (!("upgradeToHttps" in window_config) ||
                    window_config.upgradeToHttps !== false)
            ) {
                url.protocol = "https:";
                elem.setAttribute(attr, url.toString());
            }
        } catch (err) {
            // Some invalid filenames, like `///`, could raise a TypeError. Let's fail silently in this situation.
        }
    }
}

/**
 * Returns whether the given filename ends in a known flash extension.
 *
 * @param filename The filename to test.
 * @returns True if the filename is a flash movie (swf or spl).
 */
export function isSwfFilename(filename: string | null): boolean {
    if (filename) {
        let pathname = "";
        try {
            // A base URL is required if `filename` is a relative URL, but we don't need to detect the real URL origin.
            pathname = new URL(filename, RUFFLE_ORIGIN).pathname;
        } catch (err) {
            // Some invalid filenames, like `///`, could raise a TypeError. Let's fail silently in this situation.
        }
        if (pathname && pathname.length >= 4) {
            const extension = pathname.slice(-4).toLowerCase();
            if (extension === ".swf" || extension === ".spl") {
                return true;
            }
        }
    }
    return false;
}

/**
 * Returns whether the given MIME type is a known flash type.
 *
 * @param mimeType The MIME type to test.
 * @returns True if the MIME type is a flash MIME type.
 */
export function isSwfMimeType(mimeType: string): boolean {
    switch (mimeType.toLowerCase()) {
        case FLASH_MIMETYPE.toLowerCase():
        case FUTURESPLASH_MIMETYPE.toLowerCase():
        case FLASH7_AND_8_MIMETYPE.toLowerCase():
        case FLASH_MOVIE_MIMETYPE.toLowerCase():
            return true;
        default:
            return false;
    }
}

/**
 * Determine if an element is a child of a node that was not supported
 * in non-HTML5 compliant browsers. If so, the element was meant to be
 * used as a fallback content.
 *
 * @param elem The element to test.
 * @returns True if the element is inside an <audio> or <video> node.
 */
export function isFallbackElement(elem: Element): boolean {
    let parent = elem.parentElement;
    while (parent !== null) {
        switch (parent.tagName) {
            case "AUDIO":
            case "VIDEO":
                return true;
        }
        parent = parent.parentElement;
    }
    return false;
}
