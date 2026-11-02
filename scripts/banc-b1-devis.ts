/**
 * BANC RÉEL B1 (décision 0049) — la lecture des devis fabriqués, mesurée.
 *
 *   npx tsx scripts/banc-b1-devis.ts            → positions seules (gratuit, sans réseau)
 *   B1_VISION=1 npx tsx scripts/banc-b1-devis.ts → + la vision RÉELLE sur le scan et sur INSIGNE (2 appels, parcimonieux)
 *
 * Pour chaque devis : lignes justes / attendues, total HT, taxes, émetteur, destinataire, méthode.
 * Le banc ne touche aucune base : la vision est appelée avec ses portes injectées (clé présente).
 */
import { attendu, BANC_DEVIS, DEVIS_INSIGNE, fichierDuDevis, type DevisFabrique } from "@/lib/pieces-lues/banc/devis-fabriques";
import { rangeesDuPdf } from "@/lib/pieces-lues/positions";
import { lireTableau, reconcilier, type LigneTableau } from "@/lib/pieces-lues/tableau";
import { repererEntetes } from "@/lib/pieces-lues/entetes";
import { emetteurEtDestinataire } from "@/lib/pieces-lues/emetteur-destinataire";
import { extractText } from "@/lib/regulatory/intelligence/extract/extract-text";
import { lireTableauParVision } from "@/lib/pieces-lues/vision-lignes";
import { callLuna, lunaConfigured, lunaModel } from "@/lib/openai-luna";
import { rasterizePdf } from "@/lib/regulatory/intelligence/ocr/ocr-engine";

const GROUPE = [
  { id: "ADVENTUM", noms: ["Adventum Pharma", "Adventum"], nifs: [], rcs: [] },
  { id: "PHARMAGENE", noms: ["Pharmagène"], nifs: [], rcs: [] },
  { id: "AMD", noms: ["AMD Life Sciences"], nifs: [], rcs: [] },
];

function justes(lu: readonly LigneTableau[], d: DevisFabrique): number {
  const a = attendu(d).lignes;
  return a.filter((x) => lu.some((l) => l.numero === x.n && l.quantite === x.qte && l.prixUnitaire === x.pu && l.montant === x.montant
    && l.designation.replace(/\s+/g, " ").toLowerCase() === x.designation.toLowerCase())).length;
}

async function main() {
  const vision = process.env.B1_VISION === "1";
  const lignes: string[] = [];
  let toutJuste = true;
  for (const d of BANC_DEVIS) {
    const octets = await fichierDuDevis(d);
    const a = attendu(d);
    const r = await rangeesDuPdf(octets);
    const texte = (await extractText("pdf", octets)).text;
    const ent = repererEntetes(texte);
    const ed = emetteurEtDestinataire({ texte, nomFichier: d.fichier, groupe: GROUPE });
    let methode = "positions";
    let lu: LigneTableau[] = [];
    let ht: number | null = ent.totalHt?.valeur ?? null;
    let emetteur = ed.emetteur.nom;
    if (r) {
      const t = lireTableau(r);
      lu = t.lignes;
      ht = ht ?? t.totalHt;
    }
    const doitVision = vision && (!r || d === DEVIS_INSIGNE);
    if (doitVision) {
      const t0 = Date.now();
      const v = await lireTableauParVision(octets, "pdf", {
        disponible: async () => lunaConfigured(), appeler: (input) => callLuna(input), pages: async (pdf, max) => (await rasterizePdf(pdf, max)).pages, modele: () => lunaModel(),
      });
      methode = `vision (${((Date.now() - t0) / 1000).toFixed(1)} s)`;
      if (v) { lu = v.lignes; ht = ht ?? v.totalHt; emetteur = emetteur ?? v.emetteur.nom; }
      else methode += " — sans réponse";
    } else if (!r) methode = "scan : vision requise (B1_VISION=1)";
    const rec = reconcilier({ lignes: lu, trous: [] }, ht);
    const n = justes(lu, d);
    const ok = n === a.lignes.length && lu.length === a.lignes.length && rec.sommeLignes === a.ht && emetteur === d.emetteur.nom;
    if (!ok && (r || doitVision)) toutJuste = false;
    lignes.push(`| ${d.fichier} | ${methode} | ${n}/${a.lignes.length}${lu.length !== a.lignes.length ? ` (${lu.length} lues)` : ""} | ${rec.sommeLignes} / ${a.ht} | ${ht ?? "—"} | ${emetteur ?? "—"} (${d.emetteur.nom}) | ${ed.destinataire?.societeId ?? "—"} | ${ok ? "✅" : "❌"} |`);
  }
  console.log("| Devis | Lecture | Lignes justes | Σ lignes / HT attendu | HT imprimé lu | Émetteur lu (attendu) | Destinataire | Verdict |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const l of lignes) console.log(l);
  process.exit(toutJuste ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
