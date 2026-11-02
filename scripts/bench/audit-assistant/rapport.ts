/**
 * LE BANC D'AUDIT (décision 0050) — LE RAPPORT : un tableau de bord Markdown ET HTML (autonome, sans dépendance) par
 * catégorie, chaque échec avec sa conversation exacte et la donnée en cause, plus le JSON brut du passage.
 */
import fs from "node:fs";
import path from "node:path";
import { CATEGORIES_ATTAQUE, CATEGORIES_TACHE, type Fuite, type Lecture, type NoteMail } from "@/modules/assistant-ia/api-banc";

export interface Echange { qui: string; texte: string; outils?: string[]; carte?: string; erreur?: string }
export interface ResultatAttaque {
  id: string; categorie: string; persona: string; voie: string; piege: string | null;
  verdict: "BLOQUÉE" | "LUE" | "PASSÉE" | "ERREUR";
  fuites: Fuite[]; lectures: Lecture[]; actes: string[]; salutation: string | null; echanges: Echange[];
  ms: number; coutUsd: number; appels: number; erreur: string | null;
}
export interface ResultatTache {
  id: string; categorie: string; persona: string; verdict: "RÉUSSIE" | "ÉCHEC" | "FUITE" | "ERREUR";
  motifs: string[]; questions: number; carte: string | null; objetCree: boolean | null; fichiers: string[];
  mail: { grille: NoteMail; juge: { note: number | null; avis: string; coutUsd: number }; objet: string; corps: string; destinataires: string } | null;
  fauxFait: string | null; fuites: Fuite[]; echanges: Echange[]; ms: number; coutUsd: number; appels: number; erreur: string | null;
}
export interface Passage {
  quand: string; modele: string; juge: string; budgetUsd: number; budgetAtteint: boolean; depenseUsd: number; jugeUsd: number;
  attaques: ResultatAttaque[]; taches: ResultatTache[]; nonJouees: string[];
}

const q = (xs: number[], p: number) => { const t = [...xs].sort((a, b) => a - b); return t.length ? t[Math.min(t.length - 1, Math.round((p / 100) * (t.length - 1)))]! : 0; };
const moy = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const s1 = (n: number) => n.toFixed(1).replace(".", ",");
const usd = (n: number) => `${n.toFixed(3)} $`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function syntheses(p: Passage) {
  const att = CATEGORIES_ATTAQUE.map((c) => {
    const xs = p.attaques.filter((a) => a.categorie === c);
    return { c, n: xs.length, bloquees: xs.filter((a) => a.verdict === "BLOQUÉE").length, lues: xs.filter((a) => a.verdict === "LUE").length, passees: xs.filter((a) => a.verdict === "PASSÉE").length, erreurs: xs.filter((a) => a.verdict === "ERREUR").length, cout: xs.reduce((x, a) => x + a.coutUsd, 0) };
  }).filter((l) => l.n);
  const tac = CATEGORIES_TACHE.map((c) => {
    const xs = p.taches.filter((t) => t.categorie === c);
    const mails = xs.map((t) => t.mail).filter((m): m is NonNullable<ResultatTache["mail"]> => !!m);
    return {
      c, n: xs.length, reussies: xs.filter((t) => t.verdict === "RÉUSSIE").length, questions: moy(xs.map((t) => t.questions)),
      sansQuestion: xs.filter((t) => t.questions === 0).length, grille: mails.length ? moy(mails.map((m) => (8 * m.grille.note) / m.grille.sur)) : null,
      juge: mails.filter((m) => m.juge.note != null).length ? moy(mails.filter((m) => m.juge.note != null).map((m) => m.juge.note!)) : null,
      p50: q(xs.map((t) => t.ms), 50), cout: xs.reduce((x, t) => x + t.coutUsd, 0),
    };
  }).filter((l) => l.n);
  return { att, tac };
}

function conversationMd(e: Echange[]): string {
  return e.map((x) => `> **${x.qui}** : ${x.texte.replace(/\n+/g, " ").slice(0, 900)}${x.outils?.length ? `  \n> _outils : ${x.outils.join(", ")}_` : ""}${x.carte ? `  \n> _carte : ${x.carte.slice(0, 400)}_` : ""}${x.erreur ? `  \n> _erreur : ${x.erreur}_` : ""}`).join("\n>\n");
}

export function markdown(p: Passage): string {
  const { att, tac } = syntheses(p);
  const passees = p.attaques.filter((a) => a.verdict === "PASSÉE");
  const lues = p.attaques.filter((a) => a.verdict === "LUE");
  const echecs = p.taches.filter((t) => t.verdict !== "RÉUSSIE");
  const mails = p.taches.filter((t) => t.mail);
  const L: string[] = [];
  L.push(`# Banc d'audit permanent de l'Assistant IA — passage du ${p.quand.slice(0, 16).replace("T", " ")} UTC`, "");
  L.push(`Modèle **${p.modele}** · juge des mails **${p.juge}** · dépense **${usd(p.depenseUsd)}** (juge ${usd(p.jugeUsd)}) sur un budget de ${p.budgetUsd} $${p.budgetAtteint ? " — **plafond atteint**" : ""} · décision [0050](../../decisions/0050-banc-audit-permanent.md).`, "");
  L.push(`**Attaques : ${p.attaques.length} jouées — ${p.attaques.filter((a) => a.verdict === "BLOQUÉE").length} bloquées, ${lues.length} bloquées mais LUES en base, ${passees.length} PASSÉES (défaut bloquant), ${p.attaques.filter((a) => a.verdict === "ERREUR").length} en erreur.**  `);
  L.push(`**Tâches : ${p.taches.length} jouées — ${p.taches.filter((t) => t.verdict === "RÉUSSIE").length} réussies, questions moyennes ${s1(moy(p.taches.map((t) => t.questions)))}, ${p.taches.filter((t) => t.questions === 0).length} sans aucune question.**${p.nonJouees.length ? `  \nNon jouées (plafond) : ${p.nonJouees.join(", ")}` : ""}`, "");
  L.push("## Attaques par catégorie", "", "| Catégorie | Jouées | Bloquées | Lues en base | **Passées** | Erreurs | Coût |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const l of att) L.push(`| ${l.c} | ${l.n} | ${l.bloquees} | ${l.lues} | **${l.passees}** | ${l.erreurs} | ${usd(l.cout)} |`);
  L.push("", "## Tâches par catégorie", "", "| Catégorie | Jouées | Réussies | Questions moy. | Sans question | Mail (grille /8) | Mail (juge /5) | Latence P50 | Coût |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const l of tac) L.push(`| ${l.c} | ${l.n} | ${l.reussies} | ${s1(l.questions)} | ${l.sansQuestion} | ${l.grille == null ? "—" : s1(l.grille)} | ${l.juge == null ? "—" : s1(l.juge)} | ${s1(l.p50 / 1000)} s | ${usd(l.cout)} |`);
  L.push("", `## Défauts bloquants — attaques PASSÉES (${passees.length})`, "");
  if (!passees.length) L.push("Aucune : aucune valeur sensible d'autrui retrouvée, aucun acte hors droit exécuté.");
  for (const a of passees) {
    L.push(`### ✗ ${a.id} — ${a.categorie} · ${a.persona} (${a.voie})${a.piege ? ` · piège ${a.piege}` : ""}`, "");
    for (const f of a.fuites) L.push(`- **${f.temoin.libelle}** retrouvé dans **${f.ou}** : « …${f.extrait}… »`);
    for (const x of a.actes) L.push(`- **ACTE HORS DROIT** : ${x}`);
    L.push("", conversationMd(a.echanges), "");
  }
  L.push("", `## Défense en profondeur — bloquées, mais la ligne d'autrui a été LUE en base (${lues.length})`, "");
  for (const a of lues) L.push(`- **${a.id}** (${a.persona}) : ${a.lectures.map((l) => `${l.modele}.${l.operation} → ${l.temoin}`).join(" ; ")}`);
  const salut = p.attaques.filter((a) => a.salutation);
  if (salut.length) { L.push("", "## Salutations fausses (« Salut Amine » à Radia)", ""); for (const a of salut) L.push(`- ${a.id} (${a.persona}) : salué « ${a.salutation} »`); }
  L.push("", `## Tâches en échec (${echecs.length})`, "");
  for (const t of echecs) {
    L.push(`### ✗ ${t.id} — ${t.categorie} · ${t.persona} · ${t.verdict} · ${t.questions} question(s)`, "", ...t.motifs.map((m) => `- ${m}`));
    for (const f of t.fuites) L.push(`- **FUITE** ${f.temoin.libelle} dans ${f.ou}`);
    L.push("", conversationMd(t.echanges), "");
  }
  L.push("", `## Les mails (${mails.length})`, "", "| Tâche | Grille | Manques | Juge | Avis du juge |", "|---|---:|---|---:|---|");
  for (const t of mails) L.push(`| ${t.id} | ${t.mail!.grille.note}/${t.mail!.grille.sur} | ${t.mail!.grille.manques.join(", ") || "—"} | ${t.mail!.juge.note ?? "—"} | ${t.mail!.juge.avis.replace(/\|/g, "/").slice(0, 160)} |`);
  L.push("", "## Toutes les attaques", "", "| Scénario | Persona | Voie | Verdict | Durée | Coût |", "|---|---|---|---|---:|---:|");
  for (const a of p.attaques) L.push(`| ${a.id} | ${a.persona} | ${a.voie} | ${a.verdict} | ${s1(a.ms / 1000)} s | ${usd(a.coutUsd)} |`);
  L.push("", "## Toutes les tâches", "", "| Tâche | Persona | Verdict | Questions | Durée | Coût |", "|---|---|---|---:|---:|---:|");
  for (const t of p.taches) L.push(`| ${t.id} | ${t.persona} | ${t.verdict} | ${t.questions} | ${s1(t.ms / 1000)} s | ${usd(t.coutUsd)} |`);
  return L.join("\n") + "\n";
}

export function html(p: Passage): string {
  const { att, tac } = syntheses(p);
  const passees = p.attaques.filter((a) => a.verdict === "PASSÉE");
  const echecs = p.taches.filter((t) => t.verdict !== "RÉUSSIE");
  const conv = (e: Echange[]) => `<div class="conv">${e.map((x) => `<p><b>${esc(x.qui)}</b> ${esc(x.texte.slice(0, 1200))}${x.carte ? `<br><i>carte : ${esc(x.carte.slice(0, 400))}</i>` : ""}${x.outils?.length ? `<br><i>outils : ${esc(x.outils.join(", "))}</i>` : ""}</p>`).join("")}</div>`;
  const tuile = (v: string, l: string, k = "") => `<div class="tuile ${k}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Banc d'audit IA</title>
<style>:root{--fond:#f7f6f2;--carte:#fff;--texte:#1d1d1b;--doux:#6b6a65;--ok:#2f7d4f;--ko:#b3261e;--avert:#a8660b;--trait:#e4e1d8}
@media (prefers-color-scheme:dark){:root{--fond:#171716;--carte:#22211f;--texte:#ecebe6;--doux:#a4a29b;--trait:#36352f}}
body{margin:0;background:var(--fond);color:var(--texte);font:15px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}.doux{color:var(--doux)}.tuiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}
.tuile{background:var(--carte);border:1px solid var(--trait);border-radius:10px;padding:12px}.tuile .v{font-size:24px;font-weight:600}.tuile .l{color:var(--doux);font-size:13px}.ko .v{color:var(--ko)}.ok .v{color:var(--ok)}
table{width:100%;border-collapse:collapse;background:var(--carte);border:1px solid var(--trait);border-radius:10px;overflow:hidden;font-size:14px}th,td{padding:7px 10px;border-bottom:1px solid var(--trait);text-align:left}td.n,th.n{text-align:right}
.defaut{background:var(--carte);border:1px solid var(--trait);border-left:4px solid var(--ko);border-radius:8px;padding:10px 14px;margin:10px 0}.conv{font-size:13px;color:var(--doux);max-height:320px;overflow:auto}
.scroll{overflow-x:auto}</style></head><body><main>
<h1>Banc d'audit permanent de l'Assistant IA</h1><div class="doux">Passage du ${esc(p.quand.slice(0, 16).replace("T", " "))} UTC · modèle ${esc(p.modele)} · juge ${esc(p.juge)}</div>
<div class="tuiles">${tuile(String(p.attaques.length), "attaques jouées")}${tuile(String(passees.length), "attaques PASSÉES", passees.length ? "ko" : "ok")}${tuile(String(p.attaques.filter((a) => a.verdict === "LUE").length), "bloquées mais lues en base")}${tuile(`${p.taches.filter((t) => t.verdict === "RÉUSSIE").length}/${p.taches.length}`, "tâches réussies")}${tuile(s1(moy(p.taches.map((t) => t.questions))), "questions moyennes")}${tuile(usd(p.depenseUsd + p.jugeUsd), "coût du passage")}</div>
<h2>Attaques par catégorie</h2><div class="scroll"><table><tr><th>Catégorie</th><th class="n">Jouées</th><th class="n">Bloquées</th><th class="n">Lues</th><th class="n">Passées</th><th class="n">Erreurs</th><th class="n">Coût</th></tr>
${att.map((l) => `<tr><td>${l.c}</td><td class="n">${l.n}</td><td class="n">${l.bloquees}</td><td class="n">${l.lues}</td><td class="n"><b>${l.passees}</b></td><td class="n">${l.erreurs}</td><td class="n">${usd(l.cout)}</td></tr>`).join("")}</table></div>
<h2>Tâches par catégorie</h2><div class="scroll"><table><tr><th>Catégorie</th><th class="n">Jouées</th><th class="n">Réussies</th><th class="n">Questions</th><th class="n">Mail /8</th><th class="n">Juge /5</th><th class="n">P50</th><th class="n">Coût</th></tr>
${tac.map((l) => `<tr><td>${l.c}</td><td class="n">${l.n}</td><td class="n">${l.reussies}</td><td class="n">${s1(l.questions)}</td><td class="n">${l.grille == null ? "—" : s1(l.grille)}</td><td class="n">${l.juge == null ? "—" : s1(l.juge)}</td><td class="n">${s1(l.p50 / 1000)} s</td><td class="n">${usd(l.cout)}</td></tr>`).join("")}</table></div>
<h2>Défauts bloquants (${passees.length})</h2>${passees.length ? passees.map((a) => `<div class="defaut"><b>${esc(a.id)}</b> — ${esc(a.persona)} (${esc(a.voie)})<ul>${a.fuites.map((f) => `<li>${esc(f.temoin.libelle)} dans ${esc(f.ou)}</li>`).join("")}${a.actes.map((x) => `<li>ACTE : ${esc(x)}</li>`).join("")}</ul>${conv(a.echanges)}</div>`).join("") : "<p>Aucun.</p>"}
<h2>Tâches en échec (${echecs.length})</h2>${echecs.map((t) => `<div class="defaut"><b>${esc(t.id)}</b> — ${esc(t.persona)} · ${t.questions} question(s)<ul>${t.motifs.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>${conv(t.echanges)}</div>`).join("")}
</main></body></html>`;
}

export function ecrireRapport(p: Passage, dir: string): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const md = path.join(dir, "RAPPORT.md");
  const h = path.join(dir, "index.html");
  const j = path.join(dir, "resultats.json");
  fs.writeFileSync(md, markdown(p));
  fs.writeFileSync(h, html(p));
  fs.writeFileSync(j, JSON.stringify(p, null, 1));
  return [md, h, j];
}
