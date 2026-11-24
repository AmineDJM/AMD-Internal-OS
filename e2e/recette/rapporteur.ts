import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import type { EtapeRecette } from "./banc";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RAPPORT DE RECETTE — `rapport.json` (machine) et `rapport.md` (lisible), dans RECETTE_SORTIE.
 *
 * Un parcours = un test ; une ligne = une étape : attendu, obtenu, capture. Les parcours marqués
 * `@attend-fusion:<lot>` sont rangés à part : leur échec dit « le lot n'est pas encore là, ou ses
 * sélecteurs sont à ajuster », pas « régression » — le lecteur doit le voir au premier coup d'œil.
 * Les étapes sont lues sur la pièce jointe que chaque parcours dépose (`banc.ts`, `cloturer`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface ParcoursRapport {
  fichier: string;
  titre: string;
  tags: string[];
  statut: TestResult["status"];
  dureeMs: number;
  erreur: string | null;
  etapes: EtapeRecette[];
}

const sansAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const cellule = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ⏎ ");
const SYMBOLE: Record<string, string> = { passed: "✅ réussi", failed: "❌ échec", timedOut: "⏱️ délai dépassé", skipped: "⏭️ non joué", interrupted: "⛔ interrompu" };

export default class RapporteurRecette implements Reporter {
  private readonly parcours: ParcoursRapport[] = [];
  private debut = new Date();

  onBegin(): void {
    this.debut = new Date();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // Un test rejoué (retries) ne garde que son dernier essai.
    const idx = this.parcours.findIndex((p) => p.fichier === path.basename(test.location.file) && p.titre === test.title);
    if (idx >= 0) this.parcours.splice(idx, 1);
    const piece = result.attachments.find((a) => a.name === "recette-etapes" && a.body);
    let etapes: EtapeRecette[] = [];
    try { etapes = piece?.body ? (JSON.parse(piece.body.toString("utf8")) as EtapeRecette[]) : []; } catch { etapes = []; }
    this.parcours.push({
      fichier: path.basename(test.location.file),
      titre: test.title,
      tags: test.tags,
      statut: result.status,
      dureeMs: result.duration,
      erreur: result.error?.message ? sansAnsi(result.error.message).split("\n").slice(0, 8).join("\n") : null,
      etapes,
    });
  }

  onEnd(result: FullResult): void {
    // `--list` ou sélection vide : rien n'a été joué, pas de rapport à écrire.
    if (this.parcours.length === 0) return;
    const sortie = path.resolve(process.env.RECETTE_SORTIE ?? "recette-sortie");
    mkdirSync(sortie, { recursive: true });
    const attend = (p: ParcoursRapport) => p.tags.some((t) => t.startsWith("@attend-fusion"));
    const pret = this.parcours.filter((p) => !attend(p));
    const enAttente = this.parcours.filter(attend);
    const compte = (l: ParcoursRapport[], s: TestResult["status"]) => l.filter((p) => p.statut === s).length;
    const etapesTotal = this.parcours.reduce((n, p) => n + p.etapes.length, 0);
    const etapesOk = this.parcours.reduce((n, p) => n + p.etapes.filter((e) => e.statut === "OK").length, 0);

    writeFileSync(path.join(sortie, "rapport.json"), JSON.stringify({
      debut: this.debut.toISOString(), fin: new Date().toISOString(), statutGlobal: result.status,
      url: process.env.RECETTE_URL ?? null, parcours: this.parcours,
    }, null, 2));

    const md: string[] = [];
    md.push(`# Rapport de recette utilisateur — ${this.debut.toLocaleString("fr-FR")}`, "");
    md.push(`Serveur : ${process.env.RECETTE_URL ?? "(non précisé)"} · statut global : **${result.status}**`, "");
    md.push("| | Parcours | Réussis | Échecs | Non joués | Étapes conformes |", "|---|---|---|---|---|---|");
    md.push(`| Fusionnés | ${pret.length} | ${compte(pret, "passed")} | ${compte(pret, "failed") + compte(pret, "timedOut")} | ${compte(pret, "skipped")} | — |`);
    md.push(`| \`@attend-fusion\` | ${enAttente.length} | ${compte(enAttente, "passed")} | ${compte(enAttente, "failed") + compte(enAttente, "timedOut")} | ${compte(enAttente, "skipped")} | — |`);
    md.push(`| **Total** | ${this.parcours.length} | | | | ${etapesOk} / ${etapesTotal} |`, "");

    const parFichier = new Map<string, ParcoursRapport[]>();
    for (const p of [...this.parcours].sort((a, b) => a.fichier.localeCompare(b.fichier))) {
      parFichier.set(p.fichier, [...(parFichier.get(p.fichier) ?? []), p]);
    }
    for (const [fichier, liste] of parFichier) {
      md.push(`## ${fichier.replace(/\.recette\.ts$/, "")}`, "");
      for (const p of liste) {
        md.push(`### ${SYMBOLE[p.statut] ?? p.statut} — ${p.titre}`, "");
        if (p.tags.length) md.push(`Tags : ${p.tags.map((t) => `\`${t}\``).join(" ")} · durée ${(p.dureeMs / 1000).toFixed(1)} s`, "");
        if (p.erreur) md.push("```", p.erreur, "```", "");
        if (p.etapes.length === 0) { md.push("_Aucune étape jouée._", ""); continue; }
        md.push("| # | Qui · appareil | Étape | Attendu | Obtenu | Capture |", "|---|---|---|---|---|---|");
        for (const e of p.etapes) {
          const capture = e.capture ? `[voir](${e.capture.split(path.sep).join("/")})` : "—";
          md.push(`| ${e.n} ${e.statut === "OK" ? "✅" : "❌"} | ${cellule(e.qui ?? "—")} · ${e.appareil} | ${cellule(e.titre)} | ${cellule(e.attendu)} | ${cellule(e.obtenu)} | ${capture} |`);
        }
        md.push("");
      }
    }
    writeFileSync(path.join(sortie, "rapport.md"), md.join("\n"));
    console.log(`\nRapport de recette : ${path.join(sortie, "rapport.md")}`);
  }
}
