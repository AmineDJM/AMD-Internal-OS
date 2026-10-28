import type { PowerTool } from "@/lib/assistant/power-tools";
import { prisma } from "@/lib/prisma";
import {
  createDoc, appendToDoc, readDocText, createSheetFromTable, createPresentation, addSlide, searchContacts,
} from "@/lib/google/workspace/provider";
import { wrapUntrusted } from "@/lib/comms/untrusted";
import { geste } from "@/lib/assistant/workspace/emit";
import { sansBloquer } from "@/lib/journal";
import { EXEC, str, fr, activeOrMessage } from "./commun";

/**
 * OUTILS D'ADAM — la bureautique Google (créer, lire ou compléter un document) et les contacts
 * (`resolve_person`).
 *
 * Morceau de `ADAM_TOOLS` (`../adam-tools.ts`), recomposé dans l'ordre d'origine : l'ordre des
 * outils fait partie du prompt de l'IA.
 */
export const OUTILS_BUREAUTIQUE_CONTACTS: PowerTool[] = [
  // ───────────────────────── BUREAUTIQUE GOOGLE ─────────────────────────
  {
    def: {
      name: "gworkspace_create",
      description:
        "Crée un livrable Google : document (doc), feuille de calcul (sheet) ou présentation (slides), dans le Drive d'Adam. "
        + "Le fichier est PRIVÉ à sa création — le partager avec quelqu'un est un geste distinct, soumis à confirmation.",
      input_schema: {
        type: "object",
        properties: {
          kind: { type: "string", description: "doc | sheet | slides" },
          title: { type: "string", description: "Titre du fichier." },
          body: { type: "string", description: "doc : le texte. slides : une diapositive par bloc « Titre | Contenu » (une par ligne)." },
          header: { type: "string", description: "sheet : en-têtes séparés par des « | »." },
          rows: { type: "string", description: "sheet : une ligne par ligne de texte, cellules séparées par des « | »." },
        },
        required: ["kind", "title"],
      },
    },
    allowed: EXEC,
    label: "Livrable Google créé",
    run: async (input, user) => {
      const active = await activeOrMessage(user.id);
      if (typeof active === "string") return active;
      const kind = str(input, "kind").toLowerCase();
      const title = str(input, "title");
      if (!title) return "Donnez un titre au fichier.";
      try {
        if (kind === "doc") {
          const doc = await createDoc(active.token, title, str(input, "body"));
          return JSON.stringify({ ok: true, type: "document", id: doc.documentId, titre: doc.title, lien: doc.url });
        }
        if (kind === "sheet") {
          const header = str(input, "header").split("|").map((s) => s.trim()).filter(Boolean);
          const rows = str(input, "rows").split("\n").map((l) => l.split("|").map((c) => c.trim())).filter((r) => r.some(Boolean));
          if (header.length === 0) return "Donnez au moins les en-têtes (« header »).";
          const sheet = await createSheetFromTable(active.token, title, header, rows);
          return JSON.stringify({ ok: true, type: "feuille", id: sheet.spreadsheetId, titre: sheet.title, lien: sheet.url, lignes: rows.length });
        }
        if (kind === "slides") {
          const deck = await createPresentation(active.token, title);
          const blocks = str(input, "body").split("\n").map((l) => l.trim()).filter(Boolean);
          for (const b of blocks.slice(0, 20)) {
            const idx = b.indexOf("|");
            await addSlide(active.token, deck.presentationId, idx > 0 ? b.slice(0, idx).trim() : b, idx > 0 ? b.slice(idx + 1).trim() : "");
          }
          return JSON.stringify({ ok: true, type: "présentation", id: deck.presentationId, titre: deck.title, lien: deck.url, diapositives: blocks.length });
        }
        return "Type inconnu : doc | sheet | slides.";
      } catch (e) {
        return `Google a refusé la création : ${e instanceof Error ? e.message : "erreur inconnue"}.`;
      }
    },
  },

  {
    def: {
      name: "gdoc_read_or_append",
      description: "Lit un document Google (texte complet) ou lui AJOUTE du texte à la fin. `append` non vide = ajout.",
      input_schema: {
        type: "object",
        properties: {
          documentId: { type: "string" },
          append: { type: "string", description: "Texte à ajouter (omettre pour lire)." },
        },
        required: ["documentId"],
      },
    },
    allowed: EXEC,
    label: "Document Google lu / complété",
    run: async (input, user) => {
      const active = await activeOrMessage(user.id);
      if (typeof active === "string") return active;
      const id = str(input, "documentId");
      const append = str(input, "append");
      try {
        if (append) {
          await appendToDoc(active.token, id, append);
          return JSON.stringify({ ok: true, ajoute: append.length });
        }
        const doc = await readDocText(active.token, id);
        return JSON.stringify({
          titre: doc.title,
          contenu: wrapUntrusted(doc.text, { source: `Document Google — ${doc.title}`, kind: "document", maxChars: 9000 }),
        });
      } catch (e) {
        return `Google a refusé : ${e instanceof Error ? e.message : "erreur inconnue"}.`;
      }
    },
  },

  // ───────────────────────────── CONTACTS ─────────────────────────────
  {
    def: {
      name: "resolve_person",
      description:
        "Résout une personne (« Deepak ») vers son ADRESSE, en croisant les comptes ERP, l'annuaire d'entreprise, les fournisseurs, les contacts Google et l'historique des messages. "
        + "À utiliser AVANT de préparer un message quand on ne connaît que le prénom. Ne devine jamais : rend les candidats quand il y a doute. "
        + "SORTIE, toujours les mêmes clés : retenu (liste — LA personne à qui écrire, un élément si la résolution est certaine, VIDE sinon), "
        + "candidats (toutes les pistes, y compris en cas de doute), certain (booléen), resultat, precision. "
        + "Pour AGIR sur la personne, déployer l'étape suivante sur « retenu » — jamais sur « candidats », qui vaudrait un envoi par homonyme.",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Nom, prénom ou fragment." } },
        required: ["name"],
      },
    },
    allowed: EXEC,
    label: "Personne résolue",
    run: async (input, user) => {
      const q = str(input, "name");
      if (!q) return "Donnez un nom.";
      const [users, contacts, suppliers, seen] = await Promise.all([
        prisma.user.findMany({ where: { name: { contains: q, mode: "insensitive" }, isActive: true }, select: { name: true, email: true, role: true }, take: 5 }),
        prisma.companyContact.findMany({ where: { name: { contains: q, mode: "insensitive" }, email: { not: null } }, select: { name: true, email: true, kind: true }, take: 5 }),
        prisma.supplier.findMany({ where: { name: { contains: q, mode: "insensitive" }, contactEmail: { not: null } }, select: { name: true, contactEmail: true }, take: 5 }),
        prisma.emailRecord.findMany({
          where: { OR: [{ fromName: { contains: q, mode: "insensitive" } }, { fromAddress: { contains: q, mode: "insensitive" } }] },
          select: { fromAddress: true, fromName: true, sentAt: true },
          orderBy: { sentAt: "desc" }, take: 5,
        }),
      ]);
      let googleContacts: { displayName: string; emails: string[] }[] = [];
      const active = await activeOrMessage(user.id);
      if (typeof active !== "string") {
        googleContacts = await searchContacts(active.token, q, 5).then((r) => r.map((c) => ({ displayName: c.displayName, emails: c.emails }))).catch(sansBloquer("adam-tools.run.searchContacts", []));
      }
      const candidates = [
        ...users.map((u) => ({ source: "compte ERP", nom: u.name, adresse: u.email, detail: u.role })),
        ...contacts.map((c) => ({ source: "annuaire d'entreprise", nom: c.name, adresse: c.email!, detail: c.kind ?? undefined })),
        ...suppliers.map((s) => ({ source: "fournisseur", nom: s.name, adresse: s.contactEmail!, detail: undefined })),
        ...googleContacts.filter((c) => c.emails.length).map((c) => ({ source: "contacts Google", nom: c.displayName, adresse: c.emails[0], detail: undefined })),
        ...[...new Map(seen.map((s) => [s.fromAddress, s])).values()].map((s) => ({
          source: "a déjà écrit à Adam", nom: s.fromName ?? s.fromAddress, adresse: s.fromAddress, detail: s.sentAt ? fr(s.sentAt) : undefined,
        })),
      ];
      const unique = [...new Map(candidates.map((c) => [c.adresse.toLowerCase(), c])).values()];
      /**
       * ═══════════════════════════════════════════════════════════════════════════════════
       * LA FORME DE LA SORTIE NE DÉPEND PAS DU RÉSULTAT — sinon aucun plan ne peut la lire.
       *
       * ── LE DÉFAUT, MESURÉ DEUX FOIS SUR LA CHAÎNE HUMAINE LIVE ────────────────────────
       *
       * Cet outil rendait DEUX formes incompatibles : `{certain, candidats}` quand il trouvait,
       * `{resultat, precision}` quand il ne trouvait rien. Une mission écrit ses références au
       * moment de PLANIFIER, avant de savoir ce que la recherche va rendre. Les deux paris ont
       * échoué le même jour :
       *
       *   « {{annuaire:amel.resultat}} » — champs disponibles : certain, candidats.
       *   « {{annuaire:yacine.candidats.0.nom}} » — champs disponibles : resultat, precision.
       *
       * Chaque échec a coûté une étape morte PLUS une replanification complète : plan v4,
       * 46 étapes, 0,33 $ pour une mission qui en valait 0,20. Le planificateur n'avait pas
       * tort — la question n'avait pas de bonne réponse.
       *
       * Une sortie dont la FORME dépend de la DONNÉE est un contrat qu'on ne peut pas honorer.
       * On rend donc toujours les mêmes clés, et c'est la VALEUR qui dit l'absence : une liste
       * vide. Le moteur sait déjà quoi en faire — « si la liste amont est vide, l'étape est
       * simplement ignorée » (règle 15 du planificateur), au lieu d'échouer sur un champ absent.
       * ═══════════════════════════════════════════════════════════════════════════════════
       */
      /**
       * ── `retenu` : CE SUR QUOI ON AGIT, ET RIEN D'AUTRE ────────────────────────────────
       *
       * `candidats` est la liste du DOUTE. Un plan qui veut écrire à la personne n'avait qu'elle
       * pour cible : il déployait donc son envoi sur `candidats`. Tant qu'il n'y en a qu'un, ça
       * marche par chance ; à trois homonymes, le même plan écrit à TROIS personnes — la
       * cardinalité fausse que le compilateur existe pour refuser (§118.3), mais côté données,
       * là où il ne peut rien voir.
       *
       * `retenu` porte donc UNE personne quand la résolution est certaine, et une liste VIDE
       * sinon. Le moteur sait déjà quoi faire d'une liste vide : « si la liste amont est vide,
       * l'étape est ignorée » — au lieu d'écrire au mauvais destinataire.
       */
      return JSON.stringify({
        retenu: unique.length === 1 ? unique : [],
        candidats: unique,
        certain: unique.length === 1,
        resultat: unique.length === 0
          ? "aucune correspondance"
          : `${unique.length} correspondance${unique.length > 1 ? "s" : ""}`,
        precision: unique.length === 0
          ? `Rien pour « ${q} » : ni compte, ni contact, ni message reçu.`
          : unique.map((c) => `${c.nom} (${c.source})`).join(", "),
        consigne: unique.length > 1 ? "Plusieurs correspondances : demander laquelle plutôt que de choisir." : undefined,
      });
    },
  },
];
