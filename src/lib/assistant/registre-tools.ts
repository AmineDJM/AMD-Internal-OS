/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'OUTIL DU REGISTRE (mandat 6 §44) — Adam interroge ce qu'il sait faire, il ne le récite pas.
 *
 * ── POURQUOI UN OUTIL, ET PAS UN PARAGRAPHE DE PLUS DANS LE PROMPT ──────────────────────
 *
 * Un registre figé dans la consigne a trois défauts qui se cumulent : il coûte des jetons à
 * chaque tour, il vieillit en silence le jour où quelqu'un ajoute un outil, et il ne peut PAS
 * porter ce qui change — la fiabilité mesurée, la latence observée, le dernier échec. Une
 * capacité qui échoue une fois sur deux depuis lundi resterait décrite comme parfaite.
 *
 * Interrogé, le registre dit l'état RÉEL : ce qui existe, ce que cette personne a le droit
 * d'appeler, ce qui a été mesuré, et ce qui manque.
 *
 * ── LA RÉPONSE LA PLUS UTILE EST CELLE QUI DIT « NON » PRÉCISÉMENT ──────────────────────
 *
 * « Je ne peux pas » est la phrase la plus coûteuse du produit : elle ne dit ni pourquoi, ni ce
 * qui manque, ni ce qu'il faudrait pour que ce soit possible. `chercher` distingue donc trois
 * réponses qu'on confond d'habitude : une capacité répond ; une capacité existe mais le droit ou
 * le plafond de la mission l'écarte ; rien ne sait faire ça — et la troisième, et elle seule,
 * est une DETTE technique qui alimente la feuille de route.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PowerTool } from "@/platform/ia/outil";
import { blocTableau } from "@/lib/assistant/sandbox-tools";
import {
  feuilleDeRouteErp, ficheDe, interrogerRegistre, manquePour, sommaireDe,
  type FicheCapacite,
} from "@/platform/in-process/registre";

const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
const num = (input: Record<string, unknown>, key: string): number | undefined => {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

/** La fiabilité en clair — et « jamais mesurée » plutôt qu'un chiffre confortable. */
const direFiabilite = (f: FicheCapacite): string =>
  f.fiabilite.taux === null
    ? "jamais exécutée en mission — fiabilité inconnue"
    : `${Math.round(f.fiabilite.taux * 100)} % sur ${f.fiabilite.echantillon} appel(s)`;

const direLatence = (f: FicheCapacite): string =>
  f.latence.p50Ms === null
    ? `${f.latence.classeAnnoncee} (annoncée, jamais mesurée)`
    : `${f.latence.p50Ms} ms médiane, ${f.latence.p90Ms} ms au 90e centile`;

export const REGISTRE_TOOLS: PowerTool[] = [
  {
    def: {
      name: "registre_capacites",
      description:
        "INTERROGER LE REGISTRE DES CAPACITÉS — ce qu'Adam sait faire, ce qu'il a le droit de faire pour cette personne, ce qui a été MESURÉ, et ce qui MANQUE. "
        + "À utiliser AVANT de répondre « je ne peux pas », et pendant une mission pour choisir entre deux capacités. "
        + "questions : « chercher » (quelles capacités répondent à un besoin ; dit aussi celles qui EXISTENT mais que le droit ou le plafond de la mission écarte — une permission refusée n'est pas une absence de capacité) · "
        + "« fiche » (tout d'une capacité : entrées exactes, contrat de sortie, effet, rejouabilité, groupabilité, latence MESURÉE, fiabilité MESURÉE, risque, limites, événements laissés, dépendances) · "
        + "« manque » (est-ce que quelque chose sait faire ce besoin ? rend la NATURE de ce qui manque : capacité absente, droit, format, moteur, API…) · "
        + "« feuille_de_route » (les manques réellement rencontrés dans les missions, groupés et classés par fréquence, la dette technique SÉPARÉE de l'exploitation) · "
        + "« sommaire » (l'état du registre, y compris ce qu'il ignore : combien de capacités n'ont jamais été mesurées, combien n'ont aucun contrat de sortie). "
        + "Une capacité jamais exécutée est dite « fiabilité inconnue » — jamais « fiable ».",
      input_schema: {
        type: "object",
        properties: {
          question: { type: "string", enum: ["chercher", "fiche", "manque", "feuille_de_route", "sommaire"] },
          besoin: { type: "string", description: "chercher / manque : ce qu'on cherche à faire, en français." },
          capacite: { type: "string", description: "fiche : le nom exact de la capacité." },
          primitive: { type: "string", enum: ["INFORMATION", "CALCUL", "DOCUMENT", "REPRESENTATION", "ACTION", "ORCHESTRATION"] },
          domaine: { type: "string", description: "chercher : restreindre à un domaine (mail, drive, finance, regulatory…)." },
          effet_max: {
            type: "string",
            enum: ["READ", "ANALYZE", "PREPARE", "INTERNAL_REVERSIBLE_WRITE", "EXTERNAL_COMMUNICATION", "FINANCIAL_COMMITMENT", "HR_SENSITIVE", "DESTRUCTIVE", "SECURITY_ADMIN"],
            description: "chercher : le plafond d'effet de la mission. Ce qui est au-dessus est ÉCARTÉ, avec sa raison.",
          },
          groupable: { type: "boolean", description: "chercher : n'accepter que ce qui se déploie en éventail sur une collection." },
          jours: { type: "number", description: "feuille_de_route : la fenêtre observée (90 par défaut)." },
          limite: { type: "number" },
        },
        required: ["question"],
      },
    },
    // Aucun droit propre : le PONT compose les fiches avec `autorisee` calculé sur les droits
    // réels de la personne. Lire le registre ne donne accès à rien — c'est justement ce qui
    // permet de dire « cela existe, vous n'y avez pas droit » sans ouvrir la porte.
    allowed: () => true,
    label: "Registre des capacités",
    run: async (input, user) => {
      const question = str(input, "question").toLowerCase() || "chercher";
      const besoin = str(input, "besoin");
      const limite = num(input, "limite");

      if (question === "fiche") {
        const nom = str(input, "capacite");
        if (!nom) return JSON.stringify({ ok: false, erreur: "Précisez la capacité (son nom exact)." });
        const f = await ficheDe(user, nom);
        if (!f) return JSON.stringify({ ok: false, erreur: `Aucune capacité « ${nom} » dans le registre.`, suite: "Vérifiez le nom, ou utilisez la question « chercher »." });
        return JSON.stringify({
          ok: true,
          capacite: f.id,
          resume: f.resume,
          domaine: f.domaine,
          primitive: f.primitive,
          autorisee: f.autorisee === false ? "NON — cette personne n'a pas ce droit" : "oui",
          effet: f.effet,
          rejouable: f.rejouable,
          groupable: f.groupable,
          confirmation: f.confirmation,
          qualification: f.qualification,
          entrees: f.entrees?.map((c) => `${c.nom} : ${c.type}${c.requis ? " (obligatoire)" : ""}${c.valeurs?.length ? ` [${c.valeurs.join(" | ")}]` : ""}`) ?? "schéma inconnu du registre",
          contrat_de_sortie: f.contrat,
          latence: direLatence(f),
          depense: `${f.depense.classe} — ${f.depense.pourquoi}${f.depense.mesureUsd !== null ? ` (mesuré : ${f.depense.mesureUsd} $)` : ""}`,
          fiabilite: direFiabilite(f),
          reprises: f.fiabilite.reprises,
          dernier_echec: f.fiabilite.dernierEchec ?? "aucun",
          manque_du_dernier_echec: f.fiabilite.manque ? `${f.fiabilite.manque.nature} — ${f.fiabilite.manque.suite}` : null,
          risque: `${f.risque.niveau}${f.risque.raisons.length ? ` : ${f.risque.raisons.join(" ; ")}` : ""}`,
          limites: f.limites,
          evenements: f.evenements,
          dependances: f.dependances,
        });
      }

      if (question === "manque") {
        if (!besoin) return JSON.stringify({ ok: false, erreur: "Précisez le besoin." });
        const m = await manquePour(user, besoin);
        if (!m) {
          // LE REGISTRE A TROUVÉ DES CANDIDATS — il ne dit pas pour autant qu'ils FONT le travail.
          // Le marquage est lexical ; « enregistrer la conversation » croise `recall_conversation`
          // sans que celle-ci sache téléphoner. On rend donc les candidats et on dit au modèle que
          // le jugement lui revient, au lieu de conclure « c'est faisable » à sa place.
          const proches = await interrogerRegistre(user, { texte: besoin, autoriseeSeulement: true, limite: 6 });
          return JSON.stringify({
            ok: true, manque: null,
            candidats: proches.resultats.map((f) => ({ nom: f.id, resume: f.resume, limites: f.limites.slice(0, 2) })),
            a_faire: "Lis ces candidats : si AUCUN ne fait réellement ce qui est demandé, dis-le et nomme ce qui manque. Le registre marque des mots, il ne juge pas le sens.",
          });
        }
        return JSON.stringify({
          ok: true,
          manque: { nature: m.nature, quoi: m.quoi, ou: m.ou, confiance: m.confiance },
          dette_technique: m.dette,
          suite: m.suite,
          // Le point qui fait la différence entre une phrase d'excuse et une réponse utile.
          a_dire: m.dette
            ? `Ce n'est pas « je ne peux pas » : ${m.quoi}. ${m.suite}.`
            : `Ce n'est pas un défaut du produit : ${m.quoi}. ${m.suite}.`,
        });
      }

      if (question === "feuille_de_route") {
        const jours = num(input, "jours") ?? 90;
        const f = await feuilleDeRouteErp({ depuis: new Date(Date.now() - jours * 86_400_000) });
        const lignes = (l: typeof f.dette) => l.slice(0, limite ?? 15).map((x) => ({
          nature: x.nature, quoi: x.quoi, occurrences: x.occurrences, ou: x.capacites.join(", "),
          priorite: x.priorite, periode: x.depuis && x.jusqua ? `${x.depuis} → ${x.jusqua}` : null, suite: x.suite,
        }));
        return JSON.stringify({
          ok: true,
          fenetre: `${jours} jours`,
          echecs_observes: f.total,
          non_classes: f.nonClasses,
          dette_technique: lignes(f.dette),
          exploitation: lignes(f.exploitation),
          lecture: "La DETTE est du code à écrire. L'EXPLOITATION (droits, saisies manquantes, attentes humaines) n'en est pas : ce sont des faits normaux, comptés à part pour ne pas gonfler la feuille de route.",
          blocs: [blocTableau("Dette technique — ce que les échecs réclament", f.dette.slice(0, 15).map((x) => ({
            Nature: x.nature, Où: x.capacites.join(", "), Occurrences: x.occurrences, Priorité: x.priorite, Suite: x.suite,
          })))],
        });
      }

      if (question === "sommaire") {
        const s = await sommaireDe(user);
        return JSON.stringify({
          ok: true,
          capacites: s.total,
          declarees: s.declarees,
          mesurees: s.mesurees,
          jamais_executees: `${s.jamaisExecutees} — leur fiabilité est INCONNUE, pas bonne`,
          sans_contrat_de_sortie: `${s.sansContrat} — pour celles-là, « a répondu » ne se distingue pas de « a réussi »`,
          sans_schema_entree: s.sansSchemaEntree,
          par_primitive: s.parPrimitive,
          fragiles: s.fragiles.slice(0, 10).map((x) => `${x.id} : ${Math.round(x.taux * 100)} % sur ${x.echantillon} appel(s)`),
          a_risque: s.aRisque.slice(0, 15),
        });
      }

      // ── chercher ──────────────────────────────────────────────────────────────────────
      if (!besoin && !str(input, "domaine") && !str(input, "primitive")) {
        return JSON.stringify({ ok: false, erreur: "Précisez un besoin, un domaine ou une primitive." });
      }
      const r = await interrogerRegistre(user, {
        texte: besoin,
        primitive: (str(input, "primitive") || undefined) as never,
        domaine: str(input, "domaine") || undefined,
        effetMax: (str(input, "effet_max") || undefined) as never,
        groupable: typeof input.groupable === "boolean" ? (input.groupable as boolean) : undefined,
        autoriseeSeulement: true,
        limite: limite ?? 10,
      });

      return JSON.stringify({
        ok: true,
        besoin: besoin || null,
        examinees: r.examinees,
        capacites: r.resultats.map((f) => ({
          nom: f.id, resume: f.resume, primitive: f.primitive, effet: f.effet,
          groupable: f.groupable, rejouable: f.rejouable,
          latence: direLatence(f), fiabilite: direFiabilite(f),
          limites: f.limites.slice(0, 2),
        })),
        // LA PARTIE QUI EMPÊCHE UN FAUX « IMPOSSIBLE ».
        ecartees: r.ecartees.slice(0, 10).map((e) => ({ nom: e.id, nature: e.nature, raison: e.raison })),
        ...(r.resultats.length === 0
          ? {
            aucune: true,
            lecture: r.ecartees.some((e) => e.nature === "DROIT" || e.nature === "PLAFOND")
              ? "Une capacité EXISTE mais elle est écartée par un droit ou par le plafond de la mission. Ce n'est pas une absence de capacité : dites-le tel quel, et proposez la suite (demander le droit, relever le plafond avec un accord)."
              : "Rien dans le registre ne sait faire cela. Dites précisément ce qui manque plutôt que « je ne peux pas », et utilisez la question « manque » pour en nommer la nature."
          }
          : {}),
      });
    },
  },
];
