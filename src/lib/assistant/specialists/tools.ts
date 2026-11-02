/**
 * `consult_specialists` — l'orchestrateur délègue des sous-tâches de LECTURE à des spécialistes
 * parallèles (mandat 4 §29). Un appel, plusieurs rapports calibrés ; le tour garde le coût et la
 * latence de chacun dans sa trace (`specialiste:<id>` et les outils qu'il a appelés).
 *
 * Ce n'est pas un raccourci de droits : chaque outil qu'un spécialiste appelle repasse par
 * `executeReadTool`, donc par la revérification du module et du périmètre de la personne. Ce n'est
 * pas non plus gratuit : un spécialiste coûte un appel de plus — la description dit quand il paie.
 */

import type { PowerTool } from "@/platform/ia/outil";
import { recordTool } from "@/lib/models/telemetry";
import { LIMITE_FAITS_PAR_TOUR, type FaitSource } from "@/platform/in-process/fabric/provenance";
import { LIBELLE_CERTITUDE, LIBELLE_CONDUITE } from "@/lib/assistant/confidence/calibrate";
import { SPECIALISTES, specialiste, specialistesActifs } from "./registry";
import { deleguer, type Rapport } from "./run";

type Acteur = Parameters<PowerTool["run"]>[1];

const DEMANDES_MAX = 4;
const RAPPORT_MAX = 6_000;

export const specialistesOuverts = (): boolean => (process.env.ADAM_SPECIALISTS ?? "").toLowerCase() !== "off";

export const SPECIALIST_TOOLS: PowerTool[] = [
  {
    def: {
      name: "consult_specialists",
      description:
        "DÉLÈGUE des sous-tâches de LECTURE à des spécialistes internes qui travaillent EN PARALLÈLE (Regulatory, Legal, Finance, Documents), chacun avec "
        + "ses outils, et rendent un rapport bref CALIBRÉ (certain / probable / hypothèse / manquant / contradiction → agir / vérifier / chercher / "
        + "demander / arbitrer). À appeler quand une demande croise PLUSIEURS domaines (« fais le point complet sur Sofradis : contrat, factures, "
        + "dossiers, budget »), quand plusieurs DOCUMENTS LONGS sont à lire intégralement (un spécialiste Documents par document, en parallèle, te rend l'essentiel sans charger ta mémoire), ou quand un domaine demande plusieurs lectures pendant que tu traites le reste. PAS pour une lecture simple : "
        + "un spécialiste coûte un appel de plus — pour un seul outil, appelle l'outil. Les rapports sont des données à citer avec leur certitude ; "
        + "ce qu'un spécialiste dit « manquant » reste manquant.",
      input_schema: {
        type: "object",
        properties: {
          demandes: {
            type: "array", minItems: 1, maxItems: DEMANDES_MAX,
            items: {
              type: "object",
              properties: {
                specialiste: { type: "string", enum: SPECIALISTES.map((s) => s.id), description: `Le spécialiste. Actifs : ${specialistesActifs().map((s) => s.id).join(", ") || "aucun"}.` },
                tache: { type: "string", description: "La sous-tâche, précise : entité, période, ce qu'il faut rendre (références, chiffres, dates)." },
                contexte: { type: "string", description: "Ce que tu sais déjà et qu'il doit prendre comme donnée (facultatif)." },
              },
              required: ["specialiste", "tache"],
            },
          },
        },
        required: ["demandes"],
      },
    },
    // Fermé tant qu'AUCUN spécialiste n'a de bénéfice mesuré (§29 : aucun sans bénéfice), fermé à un
    // compte sans aucun module (rien à lire pour lui). Le vrai garde reste l'exécution de chaque
    // outil sous ses droits.
    allowed: (u) => specialistesOuverts() && specialistesActifs().length > 0 && (u.access?.modules?.size ?? 0) > 0,
    label: "Spécialistes consultés",
    run: async (input, user: Acteur) => {
      const brut = Array.isArray(input.demandes) ? (input.demandes as unknown[]) : [];
      const demandes = brut
        .filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object")
        .map((d) => ({ spec: specialiste(typeof d.specialiste === "string" ? d.specialiste : ""), tache: typeof d.tache === "string" ? d.tache.trim() : "", contexte: typeof d.contexte === "string" ? d.contexte : null }))
        .slice(0, DEMANDES_MAX);
      const refus = demandes.filter((d) => !d.spec || !d.spec.actif || !d.tache).map((d) => (d.spec ? (d.spec.actif ? "tâche vide" : `${d.spec.id} : inactif (bénéfice non mesuré)`) : "spécialiste inconnu"));
      const valides = demandes.filter((d): d is { spec: NonNullable<typeof d.spec>; tache: string; contexte: string | null } => Boolean(d.spec && d.spec.actif && d.tache));
      if (!valides.length) return JSON.stringify({ ok: false, message: `Aucune demande exploitable (${refus.join(" ; ") || "liste vide"}). Spécialistes actifs : ${specialistesActifs().map((s) => s.id).join(", ")}.` });

      // L'exécuteur du TOUR : mêmes outils, mêmes droits, même trace — importé tard pour ne pas boucler les modules.
      const { executeReadTool, assistantToolsFor, RESOLVER_WRITE_NAMES } = await import("@/lib/assistant");
      const { callClaude } = await import("@/lib/models/compat");
      const defs = assistantToolsFor(user).filter((t) => !RESOLVER_WRITE_NAMES.has(t.name));
      const t0 = Date.now();
      const rapports: Rapport[] = await Promise.all(valides.map(async ({ spec, tache, contexte }) => {
        const debut = Date.now();
        const r = await deleguer(spec, tache, contexte, { appel: callClaude, executer: (name, args) => executeReadTool(name, args, user), defs, acteur: user.id });
        recordTool({ name: `specialiste:${spec.id}`, ms: Date.now() - debut, ok: r.ok, parallel: valides.length > 1 });
        return r;
      }));
      const faits: FaitSource[] = [];
      const vus = new Set<string>();
      for (const r of rapports) for (const f of r.faits) { if (!vus.has(f.id) && faits.length < LIMITE_FAITS_PAR_TOUR) { vus.add(f.id); faits.push(f); } }
      return JSON.stringify({
        ok: rapports.some((r) => r.ok),
        parallele: valides.length > 1,
        dureeMs: Date.now() - t0,
        rapports: rapports.map((r) => ({
          specialiste: r.specialiste, libelle: r.libelle, ok: r.ok,
          certitude: r.calibration.certitude, conduite: r.calibration.conduite,
          calibration: `${LIBELLE_CERTITUDE[r.calibration.certitude]} — ${r.calibration.motif} → ${LIBELLE_CONDUITE[r.calibration.conduite]}`,
          rapport: r.texte.slice(0, RAPPORT_MAX), outils: r.outils, tours: r.tours, ms: r.ms, faits: r.faits.length, incomplet: r.incomplet,
        })),
        refus: refus.length ? refus : undefined,
        consigne: "Cite chaque rapport avec sa certitude ; « manquant » et « contradiction » se disent tels quels — ne comble pas, n'arbitre pas à leur place sans le dire.",
        _provenance: faits,
      });
    },
  },
];
