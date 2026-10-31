/**
 * EXPORTER UN GRAPHIQUE — SVG et PNG, depuis le dessin lui-même (lot K1, décision 0031).
 *
 * Le dessin de `viz-figure.tsx` colore par les jetons du thème (`hsl(var(--chief-accent))`) : un SVG copié tel quel
 * perdrait ses couleurs hors de la page. On copie donc le SVG en y POSANT les styles calculés (remplissage, trait,
 * police) de chaque élément, sur fond blanc, avec ses dimensions — le fichier s'ouvre seul, partout. Le PNG est ce
 * même SVG dessiné sur un canevas, à deux fois la taille (net sur un écran Retina et à l'impression).
 *
 * Navigateur seulement (DOM) ; aucun import.
 */

const PROPRIETES = ["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity", "fill-opacity", "font-size", "font-weight", "font-family", "text-anchor", "dominant-baseline"] as const;

/** Le SVG autonome : styles calculés posés, fond blanc, dimensions. */
export function svgAutonome(source: SVGSVGElement): string {
  const copie = source.cloneNode(true) as SVGSVGElement;
  const origines = [source, ...Array.from(source.querySelectorAll("*"))];
  const copies = [copie, ...Array.from(copie.querySelectorAll("*"))];
  origines.forEach((el, i) => {
    const cible = copies[i] as SVGElement | undefined;
    if (!cible) return;
    const cs = window.getComputedStyle(el);
    for (const p of PROPRIETES) {
      const v = cs.getPropertyValue(p);
      if (v && v !== "normal" && !(p === "opacity" && v === "1")) cible.style.setProperty(p, v);
    }
  });
  const vb = source.viewBox.baseVal;
  const largeur = vb && vb.width ? vb.width : source.clientWidth || 640;
  const hauteur = vb && vb.height ? vb.height : source.clientHeight || 360;
  copie.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copie.setAttribute("width", String(largeur));
  copie.setAttribute("height", String(hauteur));
  copie.removeAttribute("class");
  const fond = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  fond.setAttribute("x", vb && vb.width ? String(vb.x) : "0"); fond.setAttribute("y", vb && vb.height ? String(vb.y) : "0");
  fond.setAttribute("width", String(largeur)); fond.setAttribute("height", String(hauteur)); fond.setAttribute("fill", "#ffffff");
  copie.insertBefore(fond, copie.firstChild);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(copie)}`;
}

/** Faire télécharger un contenu sous un nom. */
export function telecharger(contenu: Blob, nom: string): void {
  const url = URL.createObjectURL(contenu);
  const a = document.createElement("a");
  a.href = url; a.download = nom; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4_000);
}

/** Le PNG du SVG, à `echelle` fois sa taille. */
export function pngDepuisSvg(svg: string, echelle = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * echelle)); c.height = Math.max(1, Math.round(img.height * echelle));
      const ctx = c.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error("canevas indisponible")); return; }
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG non produit"))), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("SVG illisible")); };
    img.src = url;
  });
}

/** Un nom de fichier propre depuis un titre. */
export const nomDeFichier = (titre: string, ext: string): string =>
  `${titre.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 _-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "graphique"}.${ext}`;
