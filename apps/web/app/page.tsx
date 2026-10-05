"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Heart, Search, ShieldCheck, Sparkles, Waves } from "lucide-react";

const previewGames = [
  { id: "lanterns", name: "Lucky Lanterns", category: "Slots", studio: "Cays Originals", art: "coral", mark: "7" },
  { id: "reef", name: "Reef Roulette", category: "Table", studio: "Cays Originals", art: "lagoon", mark: "00" },
  { id: "mango", name: "Mango Millions", category: "Slots", studio: "Sunroom Studio", art: "mango", mark: "M" },
  { id: "blackjack", name: "Island Blackjack", category: "Table", studio: "Cays Originals", art: "night", mark: "21" },
  { id: "palm", name: "Palm Fortune", category: "Slots", studio: "Sunroom Studio", art: "palm", mark: "P" },
  { id: "tide", name: "Tidal Treasures", category: "Instant", studio: "Blue Current", art: "tide", mark: "✦" },
];

const categories = ["All games", "Slots", "Table", "Instant"];

export default function Home() {
  const [games, setGames] = useState(previewGames);
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);
  const [category, setCategory] = useState("All games");
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/games", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Catalog unavailable");
        return response.json() as Promise<{ games: typeof previewGames }>;
      })
      .then(({ games: catalogGames }) => {
        setGames(catalogGames);
        setCatalogUnavailable(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setCatalogUnavailable(true);
      });
    return () => controller.abort();
  }, []);

  const filteredGames = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return games.filter((game) => {
      const matchesCategory = category === "All games" || game.category === category;
      const matchesQuery = !normalizedQuery || `${game.name} ${game.studio}`.toLowerCase().includes(normalizedQuery);
      return matchesCategory && matchesQuery;
    });
  }, [category, games, query]);

  function toggleFavorite(id: string) {
    setFavorites((current) => current.includes(id) ? current.filter((favorite) => favorite !== id) : [...current, id]);
  }

  return (
    <main>
      <div className="mode-bar"><span className="mode-dot" /> DEMO MODE <span>/</span> ISLAND CREDITS ONLY <span>/</span> NO CASH VALUE</div>
      <header className="site-header">
        <a className="brand" href="#home" aria-label="Luck-Cays home"><span className="brand-mark"><Waves size={19} /></span>luck<span className="brand-dash">-</span>cays</a>
        <nav className="main-nav" aria-label="Main navigation">
          <a className="is-active" href="#home">Home</a><a href="#games">Games</a><a href="#coming-soon">Promotions</a><a href="#responsible">Play well</a>
        </nav>
        <div className="header-actions"><a href="/admin">Admin sign in</a><button type="button" disabled title="Deposits are not available">Deposits off</button></div>
      </header>

      <section className="hero" id="home" aria-labelledby="hero-title">
        <div className="hero-photo" role="img" aria-label="Sunlit tropical shoreline" />
        <div className="hero-shade" />
        <div className="hero-copy">
          <div className="eyebrow"><Sparkles size={14} /> YOUR ISLAND, YOUR PACE</div>
          <h1 id="hero-title">A little more<br /><em>island</em> in every day.</h1>
          <p>Find your favorite games, settle in, and enjoy the good part. For now, it is all just for fun.</p>
          <a className="primary-button" href="#games">Explore the games <ArrowRight size={17} /></a>
          <div className="hero-proof"><ShieldCheck size={16} /> A safer-play-first space, always.</div>
        </div>
        <div className="hero-caption"><span>DEMO GAME ROOM</span><span>ISLAND CREDITS HAVE NO CASH VALUE</span></div>
      </section>

      <section className="quick-strip" aria-label="Demo environment status">
        <div><span className="strip-icon"><Sparkles size={17} /></span><span><strong>Island Credits</strong><small>In-site demo currency with no cash value</small></span></div>
        <div><span className="strip-icon"><ShieldCheck size={17} /></span><span><strong>Safety comes first</strong><small>No deposits, withdrawals, or cash prizes</small></span></div>
        <a href="#responsible">Our play-well promise <ArrowRight size={15} /></a>
      </section>

      <section className="games-section" id="games" aria-labelledby="games-title">
        <div className="section-heading">
          <div><div className="eyebrow eyebrow-dark">THE GAME ROOM</div><h2 id="games-title">Pick your kind of <em>fun.</em></h2></div>
          <p>Little escapes, island style.<br />Every title here is a demo preview.</p>
        </div>
        <div className="game-controls">
          <div className="category-list" role="group" aria-label="Filter games by category">
            {categories.map((item) => <button key={item} type="button" className={category === item ? "is-selected" : ""} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>)}
          </div>
          <label className="search-box"><Search size={17} /><span className="sr-only">Search games</span><input type="search" placeholder="Find a game" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        </div>
        <div className="game-grid">
          {filteredGames.map((game) => (
            <article className="game-card" key={game.id}>
              <div className={`game-art art-${game.art}`}>
                <span className="art-sun" /><span className="art-ring" /><span className="art-mark">{game.mark}</span>
                <span className="demo-tag">DEMO PREVIEW</span>
                <button className={`favorite-button${favorites.includes(game.id) ? " is-favorite" : ""}`} type="button" aria-label={`${favorites.includes(game.id) ? "Remove" : "Add"} ${game.name} ${favorites.includes(game.id) ? "from" : "to"} favorites`} aria-pressed={favorites.includes(game.id)} onClick={() => toggleFavorite(game.id)}><Heart size={17} fill={favorites.includes(game.id) ? "currentColor" : "none"} /></button>
              </div>
              <div className="game-details"><div><span className="game-category">{game.category}</span><h3>{game.name}</h3><p>{game.studio}</p></div><button type="button" className="play-button" disabled title="Demo launches are coming soon" aria-label={`${game.name}: demo launch coming soon`}><ArrowRight size={18} /></button></div>
            </article>
          ))}
          {filteredGames.length === 0 && <p className="empty-state">No games match that search. Try another title or category.</p>}
        </div>
        {catalogUnavailable && <p className="catalog-notice" role="status">Showing local demo previews; the saved game catalog is unavailable.</p>}
        <div className="games-footnote"><span>✦ DEMO CATALOG</span><span>{filteredGames.length} TITLES</span></div>
      </section>

      <section className="island-note" id="coming-soon"><div><div className="eyebrow eyebrow-dark">A NOTE FROM THE ISLAND</div><h2>Good things take <em>good care.</em></h2></div><p>Promotions, live tables, and real-money features are not active. We are building the foundations first, with safety and local requirements leading every next step.</p><span className="coming-soon-label">MORE TO COME <ArrowRight size={15} /></span></section>
      <section className="responsible-section" id="responsible"><div className="responsible-icon"><ShieldCheck size={24} /></div><div><div className="eyebrow">PLAY WELL, ALWAYS</div><h2>Fun should feel <em>good.</em></h2></div><p>Set your own pace. Take a break whenever you need one. Island Credits are for in-site testing only and cannot be bought, withdrawn, or exchanged for cash prizes.</p><a href="#legal">Learn about responsible play <ArrowRight size={16} /></a></section>
      <section className="account-strip" id="account"><div><span className="eyebrow eyebrow-dark">YOUR ISLAND ACCOUNT</span><h2>Account tools are <em>on the way.</em></h2></div><p>Sign-in, verification, wallet history, and security settings will arrive after the secure account foundations are ready.</p><a href="#games" className="text-link">Browse demos <ArrowRight size={16} /></a></section>

      <footer className="site-footer" id="legal">
        <div className="footer-main"><a className="brand footer-brand" href="#home"><span className="brand-mark"><Waves size={19} /></span>luck<span className="brand-dash">-</span>cays</a><p>Take the long way to the good time.</p><a className="footer-help" href="#responsible">Need a hand? Start here.</a></div>
        <div className="footer-links"><a href="#legal">Terms</a><a href="#legal">Privacy</a><a href="#responsible">Responsible play</a><a href="#coming-soon">Compliance info</a><a href="/admin">Admin</a></div>
        <div className="footer-bottom"><span>© 2026 Luck-Cays. Demo experience only.</span><span>Not available for real-money play.</span></div>
      </footer>
    </main>
  );
}
