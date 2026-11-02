/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * REJOUER UN TOUR DE L'ASSISTANT IA À L'IDENTIQUE (J14, décision 0022) — sans rappeler le modèle.
 *
 *   npm run assistant:rejouer -- <id de la réponse ou du message>              # rejoue (base LOCALE)
 *   npm run assistant:rejouer -- <id> --exporter trace.json                    # exporte (lecture seule, toute base)
 *   npm run assistant:rejouer -- --fichier trace.json                          # rejoue une trace exportée (base locale)
 *
 * Le rejeu passe par la vraie boucle (`repondreAvecSecours`) : le modèle est remplacé par ses sorties enregistrées,
 * les outils par les leurs. Il dit le texte rejoué, l'original, et chaque DIVERGENCE (prompt, outil, texte) — c'est là
 * que le comportement a changé. Le rejeu écrit au journal de consommation (fournisseur « rejeu », coût nul) : il est
 * refusé contre une base distante — exporter la trace, puis la rejouer en local.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import { prisma, estUneBaseLocale } from "@/lib/prisma";
import { decoderTrace, lireTrace, rejouerTrace, type Trace } from "@/modules/assistant-ia/api";

async function main() {
  const args = process.argv.slice(2);
  const opt = (nom: string) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : undefined; };
  const fichier = opt("--fichier");
  const exporter = opt("--exporter");
  const id = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--fichier" && args[i - 1] !== "--exporter");

  let trace: Trace | null = null;
  if (fichier) {
    const brut = fs.readFileSync(fichier);
    trace = brut[0] === 0x1f ? decoderTrace(brut) : (JSON.parse(brut.toString("utf8")) as Trace);
  } else if (id) {
    trace = await lireTrace(id);
  }
  if (!trace) throw new Error(id || fichier ? `Aucune trace pour « ${id ?? fichier} » (gardées ${process.env.ASSISTANT_IA_TRACES_JOURS ?? 30} jours).` : "Usage : npm run assistant:rejouer -- <id> [--exporter f.json] | --fichier f.json");

  if (exporter) {
    fs.writeFileSync(exporter, JSON.stringify(trace, null, 2));
    console.log(`Trace du tour ${trace.tourId} exportée : ${exporter} (${trace.appels.length} appels, ${trace.sorties.length} sorties d'outils).`);
    return;
  }
  if (!estUneBaseLocale(process.env.DATABASE_URL ?? "")) {
    throw new Error("Refus : le rejeu écrit au journal de consommation. Exporter la trace (--exporter), puis la rejouer contre une base locale (--fichier).");
  }
  console.log(`Tour ${trace.tourId} du ${trace.quand} · ${trace.appels.length} appels enregistrés · outils : ${trace.sorties.map((s) => s.nom).join(", ") || "aucun"}`);
  const b = await rejouerTrace(trace);
  console.log(`\nRejoué (${b.appelsRejoues}/${b.appelsEnregistres} appels du tour) — ${b.identique ? "IDENTIQUE" : "DIVERGENT"}`);
  console.log(`Texte rejoué :\n${b.texte}\n`);
  if (!b.identique) {
    console.log(`Texte original :\n${b.texteOriginal ?? "(aucun : le tour avait échoué)"}\n`);
    for (const d of b.divergences) console.log(`  ✗ ${d}`);
  }
  if (b.erreur) console.log(`Erreur au rejeu : ${b.erreur}`);
  if (!b.identique) process.exitCode = 1;
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
