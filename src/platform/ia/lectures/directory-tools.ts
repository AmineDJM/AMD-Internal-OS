import type { PowerTool } from "@/platform/ia/outil";
import { prisma } from "@/lib/prisma";
import { DirectoryChannel } from "@prisma/client";
import { findPeople } from "@/lib/directory/resolve";
import { canReadDirectory } from "@/lib/directory/access";
import { userCan } from "@/lib/rbac";
import { chargeMetriques, geste } from "@/platform/ia/workspace/emit";
import { personRegulatoryLoad } from "@/platform/ia/lectures/regulatory-read";
import { resultatIndisponible } from "@/platform/ia/lectures/capability-failure";

/**
 * L'ANNUAIRE, VU PAR ADAM — pour qu'il cesse de répondre « je n'ai pas son adresse ».
 *
 * Deux outils, et la frontière entre eux est celle de la question posée :
 *
 *   • `directory_lookup` — UNE personne. « L'adresse de Raihana ? » Il rend ses coordonnées avec
 *     leur PROVENANCE, parce qu'une adresse vérifiée en interne et une adresse aperçue dans un
 *     vieux fil ne se valent pas, et que le PDG a le droit de savoir laquelle il regarde.
 *
 *   • `directory_list` — LA LISTE. « Donne-moi les salariés et leurs e-mails » est une demande de
 *     tableau, pas le début d'une conversation : demander « pour une personne ou toute la
 *     liste ? » fait perdre un tour sur une question déjà tranchée par la phrase.
 *
 * Ils LISENT, ils n'écrivent pas : enrichir l'annuaire est le geste de l'assistante de direction,
 * sur son écran, avec l'audit qui va avec.
 */

const str = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : "";

const CONFIDENCE_LABEL: Record<string, string> = {
  VERIFIED_INTERNAL: "vérifiée en interne",
  VERIFIED_PROVIDER: "compte / fiche ERP",
  OBSERVED_HISTORY: "vue en correspondance",
  INFERRED: "déduite — à confirmer",
};

export const DIRECTORY_TOOLS: PowerTool[] = [
  {
    def: {
      name: "directory_lookup",
      description:
        "L'ANNUAIRE INTERNE : retrouve une personne (salarié, compte ERP, contact d'entreprise) et TOUTES ses coordonnées — "
        + "adresses professionnelles, personnelles, téléphone, WhatsApp — avec la PROVENANCE de chacune —, son poste, son département et son "
        + "RESPONSABLE (N+1) : « qui est le manager d'Assia ? ». "
        + "À utiliser dès qu'il faut une adresse ou un numéro : « l'e-mail de Raihana », « le numéro de l'imprimeur », « comment joindre Deepak ». "
        + "Ne JAMAIS répondre « je n'ai pas son adresse » sans avoir appelé cet outil.",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Nom, prénom ou alias de la personne cherchée." } },
        required: ["name"],
      },
    },
    allowed: canReadDirectory,
    label: "Annuaire consulté",
    run: async (input, user) => {
      const name = str(input, "name");
      if (name.length < 2) return resultatIndisponible("MISSING_INPUT", "Donnez le nom de la personne.");
      const people = await findPeople(name, 5);
      if (people.length === 0) {
        return JSON.stringify({
          // LE CONTRAT MACHINE SOUS LA PROSE. `items` et `count` sont ce que le runtime sait
          // compter ; « personne introuvable » reste pour l'humain. Sans le compte, une
          // recherche infructueuse ne peut PAS servir de preuve d'absence au juge (§ le run
          // Render où « il n'existe rien sur cette molécule » n'était pas démontrable).
          items: [],
          count: 0,
          resultat: "personne introuvable",
          precision: `Aucune entrée « ${name} » dans l'annuaire interne, les fiches RH, les comptes ERP ni les contacts d'entreprise.`,
        });
      }
      const fiches = people.map((p) => ({
        nom: p.name,
        poste: p.jobTitle,
        entite: p.company,
        ...(p.department ? { departement: p.department } : {}),
        // Le N+1 n'est pas une donnée sensible : l'organigramme le montre à tous.
        responsable: p.manager ?? (p.employeeId ? "non renseigné sur la fiche RH" : undefined),
        coordonnees: p.endpoints.map((e) => ({
          canal: e.channel === DirectoryChannel.EMAIL ? "e-mail" : e.channel === DirectoryChannel.PHONE ? "téléphone" : "WhatsApp",
          valeur: e.value,
          usage: e.label,
          fiabilite: CONFIDENCE_LABEL[e.confidence] ?? e.confidence,
          principale: e.isPrimary || undefined,
        })),
      }));

      /**
       * LA FICHE MONTRÉE — et les trois chiffres qui répondent à la vraie question.
       *
       * « Montre-moi Raihana » n'est presque jamais une demande de coordonnées : c'est le début
       * d'une conversation sur son travail. La charge réglementaire est donc lue ICI, une seule
       * fois, pour la SEULE personne trouvée — la calculer pour cinq homonymes coûterait cinq
       * requêtes pour un écran qui n'en montrerait aucune en évidence.
       *
       * Si elle ne porte aucun dossier, aucun chiffre ne s'affiche : « 0 dossier · 100 % à jour »
       * serait vrai et vide de sens.
       */
      const seule = people.length === 1 ? people[0] : null;
      const charge = seule ? await personRegulatoryLoad(seule.name, user) : null;
      const bloc = seule
        ? {
            kind: "people",
            title: seule.name,
            people: [{
              ...fiches[0],
              ...(charge?.actif ? { statut: { label: "Active", ton: "succes" } } : {}),
              ...(charge && charge.total > 0 ? { metriques: chargeMetriques(charge.total, charge.enRetard) } : {}),
              ...(charge?.href ? { href: charge.href } : {}),
            }],
            actions: [
              ...(charge && charge.enRetard > 0
                ? [geste("Ses dossiers en retard", `Montre les dossiers en retard de ${seule.name}, dans un tableau`, "primaire")]
                : charge && charge.total > 0
                  ? [geste("Ses dossiers", `Montre les dossiers de ${seule.name}, dans un tableau`, "primaire")]
                  : []),
              geste("Écrire", `Prépare un mail à ${seule.name}`),
              geste("Assigner une tâche", `Demande une tâche à ${seule.name}`),
            ],
          }
        : null;

      return JSON.stringify({
        personnes: fiches,
        ...(charge && charge.total > 0
          ? { charge: { dossiersGeres: charge.total, enRetard: charge.enRetard } }
          : {}),
        note: "Pour écrire, préférer une coordonnée vérifiée. Si deux adresses vérifiées coexistent, demander laquelle en UNE question courte.",
        ...(bloc ? { _blocs: [bloc] } : {}),
      });
    },
  },

  {
    def: {
      name: "directory_list",
      description:
        "LA LISTE des personnes de l'entreprise avec leurs coordonnées — répond directement à « donne-moi les salariés et leurs e-mails », "
        + "« la liste des contacts », « qui travaille au service réglementaire », « les adresses mail des salariés ». Rend un tableau prêt à lire. "
        + "Ne JAMAIS demander « pour une personne ou toute la liste ? » quand la demande porte déjà sur la liste. "
        + "Ne JAMAIS répondre « je ne peux pas confirmer la liste » ni « il faut passer par l'annuaire » : CET OUTIL EST L'ANNUAIRE. "
        + "Ne pas passer par search_everything pour des coordonnées — la recherche fédérée n'indexe pas l'annuaire et rendra zéro résultat.",
      input_schema: {
        type: "object",
        properties: {
          department: { type: "string", description: "Filtrer sur un département (optionnel)." },
          limit: { type: "number", description: "Nombre maximum de lignes (défaut 100)." },
        },
      },
    },
    // CHERCHER QUELQU'UN ≠ EXTRAIRE TOUT LE MONDE. Retrouver l'adresse d'un collègue est un
    // geste d'annuaire, ouvert. Sortir le registre COMPLET avec les coordonnées de chacun est
    // une extraction : elle se réserve à ceux qui ont déjà accès au personnel (RH) ou la vue
    // globale (PDG, Super Admin) — précisément ceux qui demandent « les salariés et leurs mails ».
    allowed: (u) => u.role === "SUPER_ADMIN" || u.role === "DIRECTION" || userCan(u, "RH", "VIEW"),
    label: "Liste de l'annuaire",
    run: async (input) => {
      const department = str(input, "department");
      const limit = Math.min(typeof input.limit === "number" ? input.limit : 100, 300);

      const employees = await prisma.employee.findMany({
        where: {
          isActive: true,
          ...(department ? { department: { contains: department, mode: "insensitive" } } : {}),
        },
        orderBy: { fullName: "asc" },
        take: limit,
        select: {
          id: true, fullName: true, position: true, department: true, email: true, phone: true,
          company: { select: { shortName: true, name: true } },
          user: { select: { email: true } },
          directoryEntry: { select: { endpoints: { where: { isActive: true }, select: { channel: true, value: true, label: true, confidence: true, isPrimary: true } } } },
        },
      });

      /**
       * ── UNE SEULE FORME, ET C'EST LA VALEUR QUI DIT L'ABSENCE (§118.20) ──────────────
       *
       * Cette sortie avait DEUX formes sans un seul champ commun :
       *   · trouvé  → { total, salaries: [...], note }
       *   · vide    → { items: [], count: 0, resultat, precision }
       *
       * MESURÉ sur la chaîne humaine live (mission `cmtvaa4uv…`). Le planificateur avait écrit
       * `{{lire:equipes-regulatory.salaries}}` — la forme que la fiche déclare, et la bonne
       * quand l'annuaire répond. Le service demandé n'a rien rendu, la forme VIDE est sortie,
       * et le moteur a répondu « l'étape a abouti mais ne rend pas « salaries » — champs
       * disponibles : count, items, resultat, precision ». Le WORKER en aval est passé FAILED
       * après deux tentatives, et avec lui DIX étapes sont restées PENDING derrière le mur —
       * dont les DEUX `send_message` qui étaient tout l'objet du jalon. Trois sous-plans plus
       * tard, le planificateur avait renoncé à solliciter et se contentait de CONSTATER le
       * blocage. Un nom de champ, quatre personnes jamais sollicitées.
       *
       * Les clés sont donc TOUJOURS les mêmes et c'est la VALEUR qui parle : `salaries: []`,
       * que le moteur sait déjà traiter (« si la liste amont est vide, l'étape est ignorée »).
       * `items` et `count` disparaissent : personne ne les lisait (vérifié sur tout le dépôt),
       * et les garder aurait fait deux noms pour la même chose (§118.5).
       */
      if (employees.length === 0) {
        return JSON.stringify({
          total: 0,
          salaries: [],
          resultat: "aucun salarié",
          precision: department ? `Aucun salarié actif dans « ${department} ».` : "Le registre RH est vide.",
          note: "Source : registre RH + annuaire interne.",
        });
      }

      return JSON.stringify({
        total: employees.length,
        // Les mêmes clés que la branche VIDE : ce qui change est la VALEUR, jamais la forme.
        resultat: `${employees.length} salarié(s)`,
        precision: null,
        salaries: employees.map((e) => {
          // L'annuaire d'abord (il porte les adresses vérifiées et les variantes), puis les
          // fiches — mais sans jamais rendre deux fois la même adresse.
          const fromDirectory = (e.directoryEntry?.endpoints ?? []).filter((p) => p.channel === DirectoryChannel.EMAIL);
          const mails = new Map<string, { adresse: string; usage: string | null; fiabilite: string }>();
          for (const p of fromDirectory) {
            mails.set(p.value, { adresse: p.value, usage: p.label, fiabilite: CONFIDENCE_LABEL[p.confidence] ?? p.confidence });
          }
          for (const fallback of [e.email, e.user?.email]) {
            if (fallback && !mails.has(fallback.toLowerCase())) {
              mails.set(fallback.toLowerCase(), { adresse: fallback.toLowerCase(), usage: "fiche ERP", fiabilite: CONFIDENCE_LABEL.VERIFIED_PROVIDER });
            }
          }
          const phones = (e.directoryEntry?.endpoints ?? []).filter((p) => p.channel !== DirectoryChannel.EMAIL).map((p) => p.value);
          if (e.phone && !phones.includes(e.phone)) phones.push(e.phone);
          return {
            // L'IDENTITÉ CANONIQUE D'ABORD (§28). Elle était SÉLECTIONNÉE et jamais rendue :
            // tout ce qui consommait cette liste devait donc désigner les gens par leur NOM, y
            // compris le déploiement en éventail d'une mission — qui retombait alors sur
            // l'INDEX de la ligne. Une liste relue dans un ordre différent faisait glisser
            // « message#7 » d'une personne à une autre, sans qu'aucune erreur n'apparaisse.
            id: e.id,
            nom: e.fullName,
            poste: e.position,
            departement: e.department,
            entite: e.company?.shortName ?? e.company?.name ?? null,
            emails: [...mails.values()],
            telephones: phones.length ? phones : undefined,
          };
        }),
        note: "Source : registre RH + annuaire interne. Une adresse manquante veut dire qu'elle n'est renseignée nulle part — elle s'ajoute dans Moyens généraux → Annuaire.",
      });
    },
  },
];
