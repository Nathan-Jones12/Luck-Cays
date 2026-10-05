/**
 * The PixiJS reel renderer.
 *
 * It renders a result it is handed; it never decides one. The server returns the stop index
 * per reel, and this spins each reel to land exactly there - so the animation is decoration
 * over an outcome that was already settled and paid.
 *
 * Symbols are drawn procedurally and baked to textures once at init. There is no art in this
 * prototype, so a symbol is a coloured tile with a glyph: that keeps the bundle free of
 * placeholder images and means a new theme needs no new assets, just a new config.
 *
 * Reel motion works on a fractional strip position. Cell `i` of a reel shows
 * `strip[(floor(pos) + i) % length]` and the whole column is offset by the fractional part,
 * so one tweened number produces continuous scrolling and lands on an exact symbol.
 */
import { Application, Container, Graphics, Sprite, Text, Texture, type Renderer } from "pixi.js";
import { gsap } from "gsap";
import type { SlotConfig, SlotLineWin, SlotScatterWin } from "@luck-cays/shared";

/** Palette applied in config order: wild and scatter first, then premiums, then lows. */
const SYMBOL_COLORS = [
  0xf5c358, // wild - gold
  0x2fd4b4, // scatter - teal
  0xf87171,
  0xfb923c,
  0xa78bfa,
  0x60a5fa,
  0x94a3b8,
  0x7f8da3,
  0x6b7a8f,
  0x5b6878,
];

const CELL_GAP = 6;
const REEL_GAP = 8;
const FRAME_PAD = 10;

/** One extra cell above and below, so a scrolling column never shows a gap at the edges. */
const BUFFER_CELLS = 2;

interface ReelView {
  container: Container;
  cells: Sprite[];
  /** Fractional position into the strip. The integer part picks symbols. */
  position: number;
}

export interface SpinOptions {
  /** Milliseconds for the first reel to settle. Later reels are staggered after it. */
  duration?: number;
  /** Extra whole revolutions before landing, for the sense of a long spin. */
  revolutions?: number;
  /** Shorter, snappier spin for autoplay and turbo. */
  quick?: boolean;
}

export class ReelRenderer {
  private app: Application | null = null;
  private reels: ReelView[] = [];
  private textures = new Map<string, Texture>();
  private highlightLayer: Container | null = null;
  private frameLayer: Container | null = null;

  private cellWidth = 0;
  private cellHeight = 0;

  private spinning = false;
  private destroyed = false;
  private resizeObserver: ResizeObserver | null = null;

  /**
   * The reel strips, resolved once.
   *
   * This renderer animates a strip travelling to a stop, so it only works for a strip game.
   * A weighted game has no strip and no stop - "242 Wild Harbour" ships its own renderer for
   * exactly that reason - so being handed one is a programming error worth failing on rather
   * than quietly drawing an empty reel.
   */
  private readonly strips: string[][];

  constructor(
    private readonly host: HTMLElement,
    private readonly config: SlotConfig,
  ) {
    if (!config.reelStrips) {
      throw new Error(
        `ReelRenderer cannot render ${config.slug}: it uses weighted reels, which have no strip to land on`,
      );
    }
    this.strips = config.reelStrips;
  }

  get isSpinning(): boolean {
    return this.spinning;
  }

  async init(): Promise<void> {
    const app = new Application();
    await app.init({
      background: 0x070d14,
      backgroundAlpha: 0,
      antialias: true,
      // Cap the device pixel ratio: a 3x phone screen would otherwise render nine times the
      // pixels for no visible gain and a real frame-rate cost.
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      width: this.host.clientWidth || 720,
      height: this.hostHeight(),
    });

    // The component may have unmounted while init was awaiting.
    if (this.destroyed) {
      app.destroy(true);
      return;
    }

    this.app = app;
    this.host.appendChild(app.canvas);
    app.canvas.style.display = "block";
    app.canvas.style.width = "100%";
    app.canvas.style.height = "auto";

    this.layout();
    this.buildTextures(app.renderer);
    this.buildReels();
    this.randomiseStops();

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.host);
  }

  private hostHeight(): number {
    const width = this.host.clientWidth || 720;
    // A 5x3 grid of roughly square cells, plus padding. Derived rather than fixed so the
    // canvas keeps its aspect on any width.
    const cell = (width - FRAME_PAD * 2 - REEL_GAP * (this.config.reels - 1)) / this.config.reels;
    return Math.round(cell * this.config.rows + CELL_GAP * (this.config.rows - 1) + FRAME_PAD * 2);
  }

  private layout(): void {
    const width = this.host.clientWidth || 720;
    this.cellWidth =
      (width - FRAME_PAD * 2 - REEL_GAP * (this.config.reels - 1)) / this.config.reels;
    this.cellHeight = this.cellWidth;
  }

  /* ------------------------------- textures -------------------------------- */

  private colorFor(symbolId: string): number {
    const index = this.config.symbols.findIndex((symbol) => symbol.id === symbolId);
    return SYMBOL_COLORS[index % SYMBOL_COLORS.length] ?? 0x94a3b8;
  }

  /** A short glyph for a symbol: card ranks stay as-is, words use their initial. */
  private glyphFor(symbolId: string): string {
    if (/^(?:[2-9]|10|[JQKA])$/.test(symbolId)) return symbolId;
    return symbolId.slice(0, 1);
  }

  /**
   * Bake one texture per symbol. Drawing each cell every frame would mean re-rasterising text
   * 25 times a frame during a spin; a texture swap is effectively free.
   */
  private buildTextures(renderer: Renderer): void {
    const w = Math.max(40, Math.round(this.cellWidth));
    const h = Math.max(40, Math.round(this.cellHeight));

    for (const symbol of this.config.symbols) {
      const color = this.colorFor(symbol.id);
      const tile = new Container();

      const body = new Graphics()
        .roundRect(1, 1, w - 2, h - 2, 10)
        .fill({ color: 0x131f2c })
        .stroke({ width: 2, color, alpha: 0.85 });

      // A wash of the symbol's colour, so a reel reads as colour blocks at a glance.
      const wash = new Graphics().roundRect(1, 1, w - 2, h - 2, 10).fill({ color, alpha: 0.13 });

      tile.addChild(body, wash);

      const isSpecial = symbol.kind !== "normal";
      const glyph = new Text({
        text: this.glyphFor(symbol.id),
        style: {
          fill: color,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          fontSize: Math.round(h * (isSpecial ? 0.42 : 0.5)),
          fontWeight: isSpecial ? "800" : "700",
          align: "center",
        },
      });
      glyph.anchor.set(0.5);
      glyph.position.set(w / 2, isSpecial ? h * 0.42 : h / 2);
      tile.addChild(glyph);

      // Wilds and scatters get a label, because which symbol does what is the first thing a
      // player needs to know and a bare letter does not say it.
      if (isSpecial) {
        const label = new Text({
          text: symbol.kind === "wild" ? "WILD" : "SCATTER",
          style: {
            fill: color,
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            fontSize: Math.max(8, Math.round(h * 0.12)),
            fontWeight: "800",
            letterSpacing: 1,
          },
        });
        label.anchor.set(0.5);
        label.position.set(w / 2, h * 0.76);
        tile.addChild(label);
      }

      this.textures.set(symbol.id, renderer.generateTexture(tile));
      tile.destroy({ children: true });
    }
  }

  /* -------------------------------- reels ---------------------------------- */

  private buildReels(): void {
    const app = this.app;
    if (!app) return;

    app.stage.removeChildren();
    this.reels = [];

    // The felt the reels sit on.
    const backdrop = new Graphics()
      .roundRect(0, 0, app.screen.width, app.screen.height, 14)
      .fill({ color: 0x0b141d })
      .stroke({ width: 1, color: 0x23374b });
    app.stage.addChild(backdrop);

    const visibleHeight = this.cellHeight * this.config.rows + CELL_GAP * (this.config.rows - 1);

    for (let reel = 0; reel < this.config.reels; reel++) {
      const column = new Container();
      column.x = FRAME_PAD + reel * (this.cellWidth + REEL_GAP);
      column.y = FRAME_PAD;

      // Clip the column so buffer cells are hidden outside the window.
      const mask = new Graphics()
        .rect(0, 0, this.cellWidth, visibleHeight)
        .fill({ color: 0xffffff });
      column.addChild(mask);
      column.mask = mask;

      const scroller = new Container();
      column.addChild(scroller);

      const cells: Sprite[] = [];
      for (let row = 0; row < this.config.rows + BUFFER_CELLS; row++) {
        const sprite = new Sprite(
          this.textures.get(this.config.symbols[0]?.id ?? "") ?? Texture.EMPTY,
        );
        sprite.width = this.cellWidth;
        sprite.height = this.cellHeight;
        sprite.y = (row - 1) * (this.cellHeight + CELL_GAP);
        scroller.addChild(sprite);
        cells.push(sprite);
      }

      app.stage.addChild(column);
      this.reels.push({ container: scroller, cells, position: 0 });
    }

    this.highlightLayer = new Container();
    this.frameLayer = new Container();
    app.stage.addChild(this.highlightLayer, this.frameLayer);
  }

  /** Point every reel at a random stop, so the grid is not all one symbol before the first spin. */
  private randomiseStops(): void {
    this.reels.forEach((reel, index) => {
      const strip = this.strips[index] ?? [];
      // Presentation only - no outcome is decided here, so Math.random is fine. Every real
      // outcome comes from the server's crypto.randomInt.
      reel.position = Math.floor(Math.random() * strip.length);
      this.paintReel(index);
    });
  }

  /** Update one reel's cell textures and scroll offset from its position. */
  private paintReel(index: number): void {
    const reel = this.reels[index];
    const strip = this.strips[index];
    if (!reel || !strip) return;

    const base = Math.floor(reel.position);
    const fraction = reel.position - base;

    for (const [cellIndex, sprite] of reel.cells.entries()) {
      // -1 so the first cell sits just above the window and scrolls into view.
      const symbolId =
        strip[(((base + cellIndex - 1) % strip.length) + strip.length) % strip.length];
      const texture = symbolId ? this.textures.get(symbolId) : undefined;
      if (texture) sprite.texture = texture;
    }

    reel.container.y = -fraction * (this.cellHeight + CELL_GAP);
  }

  /**
   * Spin to the given stops.
   *
   * Reels are staggered, and each one tweens through several whole revolutions before easing
   * onto its target. `back.out` on the final approach gives the slight overshoot and settle a
   * mechanical reel has.
   */
  async spinTo(stops: number[], options: SpinOptions = {}): Promise<void> {
    if (!this.app || this.destroyed) return;

    this.clearHighlights();
    this.spinning = true;

    const quick = options.quick ?? false;
    const duration = (options.duration ?? (quick ? 520 : 900)) / 1000;
    const revolutions = options.revolutions ?? (quick ? 2 : 4);
    const stagger = quick ? 0.055 : 0.13;

    const tweens = this.reels.map((reel, index) => {
      const strip = this.strips[index] ?? [];
      const target = stops[index] ?? 0;

      // Always travel forward past the target: landing backwards reads as a glitch.
      const current = reel.position;
      const loops = revolutions + index * 0.5;
      const destination =
        Math.ceil(current / strip.length) * strip.length + loops * strip.length + target;

      const state = { position: current };

      return gsap.to(state, {
        position: destination,
        duration: duration + index * stagger,
        ease: index === this.reels.length - 1 ? "back.out(1.1)" : "power3.out",
        onUpdate: () => {
          reel.position = state.position;
          this.paintReel(index);
        },
        onComplete: () => {
          // Snap to the exact integer stop so the grid matches the server's result precisely.
          reel.position = target;
          this.paintReel(index);
        },
      });
    });

    await Promise.all(tweens.map((tween) => tween.then()));
    this.spinning = false;
  }

  /** Jump straight to a grid with no animation, for restoring state. */
  showStops(stops: number[]): void {
    this.reels.forEach((reel, index) => {
      reel.position = stops[index] ?? 0;
      this.paintReel(index);
    });
  }

  /* ----------------------------- win highlights ---------------------------- */

  private cellRect(reel: number, row: number): { x: number; y: number } {
    return {
      x: FRAME_PAD + reel * (this.cellWidth + REEL_GAP),
      y: FRAME_PAD + row * (this.cellHeight + CELL_GAP),
    };
  }

  /** Outline the winning cells and pulse them. */
  highlightWins(lineWins: SlotLineWin[], scatterWin: SlotScatterWin | null): void {
    const layer = this.highlightLayer;
    if (!layer) return;

    this.clearHighlights();

    const draw = (cells: Array<[number, number]>, color: number) => {
      for (const [reel, row] of cells) {
        const { x, y } = this.cellRect(reel, row);
        const outline = new Graphics()
          .roundRect(x, y, this.cellWidth, this.cellHeight, 10)
          .stroke({ width: 3, color, alpha: 0.95 })
          .fill({ color, alpha: 0.12 });
        layer.addChild(outline);

        gsap.fromTo(
          outline,
          { alpha: 0.25 },
          { alpha: 1, duration: 0.45, yoyo: true, repeat: -1, ease: "sine.inOut" },
        );
      }
    };

    for (const win of lineWins) draw(win.cells, 0x4ade80);
    if (scatterWin) draw(scatterWin.cells, 0x2fd4b4);
  }

  clearHighlights(): void {
    const layer = this.highlightLayer;
    if (!layer) return;
    for (const child of layer.children) gsap.killTweensOf(child);
    layer.removeChildren().forEach((child) => child.destroy());
  }

  /* -------------------------------- lifecycle ------------------------------ */

  private handleResize(): void {
    if (!this.app || this.destroyed || this.spinning) return;

    const stops = this.reels.map((reel) => Math.floor(reel.position));
    this.layout();
    this.app.renderer.resize(this.host.clientWidth || 720, this.hostHeight());

    // Textures are sized to the cell, so they have to be rebuilt at the new scale.
    for (const texture of this.textures.values()) texture.destroy(true);
    this.textures.clear();
    this.buildTextures(this.app.renderer);
    this.buildReels();
    this.showStops(stops);
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    for (const reel of this.reels) gsap.killTweensOf(reel);
    this.clearHighlights();

    for (const texture of this.textures.values()) texture.destroy(true);
    this.textures.clear();

    // `removeView` takes the canvas out of the DOM with it.
    this.app?.destroy({ removeView: true }, { children: true, texture: true });
    this.app = null;
    this.reels = [];
  }
}
