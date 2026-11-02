import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { addAdProItem } from "@/modules/ad-pro/actions-postes";
import { ajouterHebergement, ajouterVoyageur } from "@/modules/ad-pro/actions-postes-voyageurs";
import { lireHebergement, lireVoyageur, porteDesHebergements, porteDesVoyageurs } from "@/modules/ad-pro/partage";
import { champs, dzd, nombre, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import { trouverDemande, type NatureDemande } from "./demandes-visibles";
import { dateIso } from "./adpro-prise-en-charge";
import { replier } from "./annuaire-medical";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES HÔTELLERIE ET VOYAGE D'UNE DEMANDE AD & PRO (lot T3) — « crée les fiches hôtel et billets du Dr X et du
 * Dr Y pour le congrès de la SAHGE », depuis un message, un mail ou un devis lu, SANS ressaisie.
 *
 * Le modèle donne la demande et des fiches STRUCTURÉES (personnes, villes, dates, hôtel, chambre) ; le SERVEUR contrôle
 * AVANT de remplir, par les règles de l'écran (`lireVoyageur`, `lireHebergement`) et les siennes :
 *   • la demande est cherchée parmi celles que la personne VOIT (`trouverDemande`) — jamais celle d'un autre ;
 *   • chaque fiche se lit (nom obligatoire, dates lisibles, retour ≥ départ, départ de l'hôtel > arrivée) — une fiche
 *     illisible arrête tout et la carte n'est pas proposée (le refus nomme la fiche et le champ) ;
 *   • le NOMBRE DE NUITS est calculé (jamais écrit par le modèle) ; un séjour hors des dates de voyage de la même
 *     personne, une ville d'hôtel différente de la ville d'arrivée, une date passée, un homonyme déjà sur le poste
 *     sont des AVERTISSEMENTS de la carte ;
 *   • sans poste « billetterie » / « hôtellerie », il est CRÉÉ (l'action de l'écran `addAdProItem`, qui exige la
 *     pré-validation de la Direction Marketing) avec le budget imputé donné ; un poste existant garde son montant.
 * La confirmation appelle les actions de l'écran (`ajouterVoyageur`, `ajouterHebergement`) sous UN geste : une
 * annulation retire toutes les fiches (et le poste créé).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PARENTS: Partial<Record<NatureDemande, "sponsoringId" | "congressNationalId" | "congressInternationalId" | "eventId">> = {
  SPONSORING: "sponsoringId", CONGRESS_NATIONAL: "congressNationalId", CONGRESS_INTERNATIONAL: "congressInternationalId", EVENT: "eventId",
};
const FICHES_MAX = 40;

const TRANSPORT: readonly [RegExp, string][] = [[/avion|vol|aerien|air/, "AVION"], [/train|sncf|rail/, "TRAIN"], [/bus|car\b|autocar/, "BUS"], [/taxi|vtc|voiture/, "TAXI"]];
const lireTransportLibre = (s: string): string | null => { const r = replier(s); if (!r) return null; for (const [re, v] of TRANSPORT) if (re.test(r)) return v; return null; };
const lireTrajetLibre = (s: string, retour: string | null): string => {
  const r = replier(s);
  if (/simple|aller seul|one way/.test(r)) return "ALLER_SIMPLE";
  if (/multi|plusieurs|etapes/.test(r)) return "MULTI_DESTINATIONS";
  if (/retour|ar\b|a r/.test(r)) return "ALLER_RETOUR";
  return retour ? "ALLER_RETOUR" : "ALLER_SIMPLE";
};

interface FicheVoyage { nom: string; prenom: string | null; villeDepart: string | null; villeArrivee: string | null; dateDepart: string | null; dateRetour: string | null; transport: string | null; trajet: string; notes: string | null }
interface FicheHotel { nom: string; prenom: string | null; hotel: string | null; ville: string | null; dateArrivee: string | null; dateDepart: string | null; typeChambre: string | null; notes: string | null }

const objets = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
const t = (o: Record<string, unknown>, k: string) => texte(o, k) || null;
/** « Dr Karim Benali » → nom BENALI, prénom Karim ; un nom seul reste le nom. */
function nomPrenom(o: Record<string, unknown>): { nom: string; prenom: string | null } {
  const nom = t(o, "nom"); const prenom = t(o, "prenom");
  if (nom && prenom) return { nom, prenom };
  const brut = (nom ?? t(o, "personne") ?? "").replace(/^(dr|pr|docteur|professeur|m\.|mme|mlle|monsieur|madame)\.?\s+/i, "").trim();
  const mots = brut.split(/\s+/).filter(Boolean);
  if (mots.length < 2) return { nom: brut, prenom: null };
  // Le NOM écrit en majuscules gagne ; sinon le dernier mot est le nom.
  const maj = mots.filter((m) => m.length > 1 && m === m.toUpperCase());
  if (maj.length && maj.length < mots.length) return { nom: maj.join(" "), prenom: mots.filter((m) => !maj.includes(m)).join(" ") };
  return { nom: mots[mots.length - 1]!, prenom: mots.slice(0, -1).join(" ") };
}
const cle = (n: string, p: string | null) => replier(`${p ?? ""} ${n}`).replace(/\s+/g, " ").trim();
const jour = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "?");
const nuits = (a: string | null, d: string | null) => (a && d ? Math.round((Date.parse(d) - Date.parse(a)) / 86_400_000) : null);

export const FICHES_VOYAGE: OperationIA = {
  nom: "preparer_fiches_hotellerie_voyage",
  module: "SPONSORING",
  libelle: "Fiches hôtellerie et voyage préparées",
  description:
    "CRÉE LES FICHES HÔTELLERIE ET VOYAGE (billetterie) d'une demande Ad & Pro (sponsoring, prise en charge, événement) en UNE carte : "
    + "une fiche voyage par voyageur (villes, dates, transport) et une fiche hôtellerie par personne logée (hôtel, ville, arrivée, départ, chambre). "
    + "Depuis un message, un mail ou un devis LU (lire_document) : recopie les valeurs lues, n'invente rien ; une donnée inconnue reste vide. "
    + "Le serveur contrôle les dates, calcule les nuits, repère les doublons, crée le poste « billetterie » / « hôtellerie » s'il manque (avec `budget`), et rend une carte. "
    + "Dates AAAA-MM-JJ.",
  schema: {
    type: "object",
    properties: {
      demande: { type: "string", description: "Référence ou nom de la demande Ad & Pro." },
      voyageurs: {
        type: "array", description: "Les fiches voyage (billets).",
        items: { type: "object", properties: {
          nom: { type: "string", description: "Nom de famille (ou nom complet)." }, prenom: { type: "string" },
          villeDepart: { type: "string" }, villeArrivee: { type: "string" }, depart: { type: "string", description: "AAAA-MM-JJ" }, retour: { type: "string", description: "AAAA-MM-JJ (vide : aller simple)" },
          transport: { type: "string", description: "avion, train, bus, taxi" }, trajet: { type: "string", description: "aller-retour, aller simple" }, notes: { type: "string" },
        } },
      },
      hebergements: {
        type: "array", description: "Les fiches hôtellerie.",
        items: { type: "object", properties: {
          nom: { type: "string" }, prenom: { type: "string" }, hotel: { type: "string" }, ville: { type: "string" },
          arrivee: { type: "string", description: "AAAA-MM-JJ" }, depart: { type: "string", description: "AAAA-MM-JJ" }, typeChambre: { type: "string", description: "Single, Double, Twin, Suite" }, notes: { type: "string" },
        } },
      },
      budgetBilletterie: { type: "number", description: "Budget imputé au poste billetterie s'il faut le créer (DZD)." },
      budgetHotellerie: { type: "number", description: "Budget imputé au poste hôtellerie s'il faut le créer (DZD)." },
    },
  },
  ouverte: (u) => ["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENTS"].some((m) => userCan(u, m as never, "UPDATE") || userCan(u, m as never, "CREATE")),

  async proposer(e, user: CurrentUser): Promise<PropositionOperation> {
    const vs = objets(e.voyageurs);
    const hs = objets(e.hebergements);
    const demande = await trouverDemande(user, texte(e, "demande"), "");
    const manque = [
      "manque" in demande ? demande.manque : null,
      !vs.length && !hs.length ? "les personnes à loger ou à faire voyager (nom, dates, villes, hôtel)" : null,
    ].filter((x): x is string => !!x);
    if (manque.length) return { manque };
    const d = demande as Exclude<typeof demande, { manque: string }>;
    const champ = PARENTS[d.nature];
    if (!champ) return { erreur: "Les fiches hôtellerie et voyage s'ajoutent à un sponsoring, une prise en charge ou un événement." };
    if (vs.length + hs.length > FICHES_MAX) return { erreur: `Au plus ${FICHES_MAX} fiches par carte : découpez la liste.` };

    // ── Lire et CONTRÔLER chaque fiche avant de remplir quoi que ce soit ──
    const fautes: string[] = [];
    const voyages: FicheVoyage[] = vs.map((o, i) => {
      const { nom, prenom } = nomPrenom(o);
      const depart = t(o, "depart") ? dateIso(texte(o, "depart")) : null;
      const retour = t(o, "retour") ? dateIso(texte(o, "retour")) : null;
      if (t(o, "depart") && !depart) fautes.push(`voyageur ${i + 1} (${nom || "?"}) : date de départ « ${texte(o, "depart")} » illisible`);
      if (t(o, "retour") && !retour) fautes.push(`voyageur ${i + 1} (${nom || "?"}) : date de retour « ${texte(o, "retour")} » illisible`);
      const transport = t(o, "transport") ? lireTransportLibre(texte(o, "transport")) : null;
      const f: FicheVoyage = { nom, prenom, villeDepart: t(o, "villeDepart"), villeArrivee: t(o, "villeArrivee"), dateDepart: depart, dateRetour: retour, transport, trajet: lireTrajetLibre(texte(o, "trajet"), retour), notes: t(o, "notes") };
      const lu = lireVoyageur({ ...f, trajet: f.trajet, transport: f.transport });
      if (!lu.ok) fautes.push(`voyageur ${i + 1} (${nom || "?"}) : ${lu.error}`);
      return f;
    });
    const hotels: FicheHotel[] = hs.map((o, i) => {
      const { nom, prenom } = nomPrenom(o);
      const arrivee = t(o, "arrivee") ? dateIso(texte(o, "arrivee")) : null;
      const depart = t(o, "depart") ? dateIso(texte(o, "depart")) : null;
      if (t(o, "arrivee") && !arrivee) fautes.push(`hôtellerie ${i + 1} (${nom || "?"}) : date d'arrivée « ${texte(o, "arrivee")} » illisible`);
      if (t(o, "depart") && !depart) fautes.push(`hôtellerie ${i + 1} (${nom || "?"}) : date de départ « ${texte(o, "depart")} » illisible`);
      const f: FicheHotel = { nom, prenom, hotel: t(o, "hotel"), ville: t(o, "ville"), dateArrivee: arrivee, dateDepart: depart, typeChambre: t(o, "typeChambre"), notes: t(o, "notes") };
      const lu = lireHebergement(f);
      if (!lu.ok) fautes.push(`hôtellerie ${i + 1} (${nom || "?"}) : ${lu.error}`);
      return f;
    });
    if (fautes.length) return { erreur: `Fiches non préparées — à corriger : ${fautes.join(" ; ")}.` };

    // ── Les postes : existants (choisis par nature) ou à créer ──
    const postes = await prisma.adProItem.findMany({ where: { [champ]: d.id }, select: { id: true, label: true, kind: true, amountEstimated: true } });
    const posteV = voyages.length ? postes.find((p) => porteDesVoyageurs(p.kind)) ?? null : null;
    const posteH = hotels.length ? postes.find((p) => porteDesHebergements(p.kind)) ?? null : null;
    const budgetV = nombre(e, "budgetBilletterie");
    const budgetH = nombre(e, "budgetHotellerie");

    const warnings: string[] = [];
    const aujourdhui = new Date().toISOString().slice(0, 10);
    const passees = [...voyages.map((v) => v.dateDepart), ...hotels.map((h) => h.dateArrivee)].filter((x): x is string => !!x && x < aujourdhui);
    if (passees.length) warnings.push(`${passees.length} date(s) déjà passée(s) : vérifiez l'année.`);
    for (const h of hotels) {
      const v = voyages.find((x) => cle(x.nom, x.prenom) === cle(h.nom, h.prenom));
      if (v && h.dateArrivee && v.dateDepart && h.dateArrivee < v.dateDepart) warnings.push(`${h.prenom ?? ""} ${h.nom} : arrivée à l'hôtel (${jour(h.dateArrivee)}) avant le départ du voyage (${jour(v.dateDepart)}).`.trim());
      if (v && h.dateDepart && v.dateRetour && h.dateDepart > v.dateRetour) warnings.push(`${h.prenom ?? ""} ${h.nom} : départ de l'hôtel (${jour(h.dateDepart)}) après le retour (${jour(v.dateRetour)}).`.trim());
      if (v && h.ville && v.villeArrivee && replier(h.ville) !== replier(v.villeArrivee)) warnings.push(`${h.prenom ?? ""} ${h.nom} : hôtel à ${h.ville}, voyage vers ${v.villeArrivee}.`.trim());
    }
    const dejaV = posteV ? (await prisma.adProVoyageur.findMany({ where: { itemId: posteV.id }, select: { nom: true, prenom: true } })).map((x) => cle(x.nom, x.prenom)) : [];
    const dejaH = posteH ? (await prisma.adProHebergement.findMany({ where: { itemId: posteH.id }, select: { nom: true, prenom: true } })).map((x) => cle(x.nom, x.prenom)) : [];
    const doublonsV = voyages.filter((v) => dejaV.includes(cle(v.nom, v.prenom)));
    const doublonsH = hotels.filter((h) => dejaH.includes(cle(h.nom, h.prenom)));
    if (doublonsV.length || doublonsH.length) {
      warnings.push(`Déjà sur le poste, NON recréé(s) : ${[...doublonsV.map((v) => `${v.prenom ?? ""} ${v.nom} (voyage)`), ...doublonsH.map((h) => `${h.prenom ?? ""} ${h.nom} (hôtel)`)].map((s) => s.trim()).join(", ")}.`);
    }
    const voyagesNeufs = voyages.filter((v) => !doublonsV.includes(v));
    const hotelsNeufs = hotels.filter((h) => !doublonsH.includes(h));
    if (!voyagesNeufs.length && !hotelsNeufs.length) return { erreur: "Toutes ces fiches existent déjà sur la demande : rien à créer." };
    if (posteV && budgetV !== null) warnings.push(`Le poste « ${posteV.label} » existe : son montant n'est pas modifié (${posteV.amountEstimated ? dzd(Number(posteV.amountEstimated)) : "non renseigné"}).`);
    if (posteH && budgetH !== null) warnings.push(`Le poste « ${posteH.label} » existe : son montant n'est pas modifié (${posteH.amountEstimated ? dzd(Number(posteH.amountEstimated)) : "non renseigné"}).`);

    const totalNuits = hotelsNeufs.reduce((s, h) => s + (nuits(h.dateArrivee, h.dateDepart) ?? 0), 0);
    return {
      carte: {
        title: `Fiches ${[voyagesNeufs.length ? `voyage (${voyagesNeufs.length})` : null, hotelsNeufs.length ? `hôtellerie (${hotelsNeufs.length})` : null].filter(Boolean).join(" et ")} — ${d.libelle}`,
        fields: champs([
          ["Demande", d.libelle],
          ["Poste billetterie", voyagesNeufs.length ? (posteV ? posteV.label : `À CRÉER « Billetterie »${budgetV !== null ? ` — budget ${dzd(budgetV)}` : ""}`) : null],
          ["Poste hôtellerie", hotelsNeufs.length ? (posteH ? posteH.label : `À CRÉER « Hôtellerie »${budgetH !== null ? ` — budget ${dzd(budgetH)}` : ""}`) : null],
          ...voyagesNeufs.map((v, i): [string, string] => [`Voyage ${i + 1}`, `${[v.prenom, v.nom].filter(Boolean).join(" ")} — ${v.villeDepart ?? "?"} → ${v.villeArrivee ?? "?"} — ${jour(v.dateDepart)}${v.trajet === "ALLER_RETOUR" ? ` → ${jour(v.dateRetour)}` : " (aller simple)"}${v.transport ? ` — ${v.transport.toLowerCase()}` : ""}`]),
          ...hotelsNeufs.map((h, i): [string, string] => {
            const n = nuits(h.dateArrivee, h.dateDepart);
            return [`Hôtellerie ${i + 1}`, `${[h.prenom, h.nom].filter(Boolean).join(" ")} — ${h.hotel ?? "hôtel à préciser"}${h.ville ? `, ${h.ville}` : ""} — ${jour(h.dateArrivee)} → ${jour(h.dateDepart)}${n !== null ? ` (${n} nuit${n > 1 ? "s" : ""})` : ""}${h.typeChambre ? ` — ${h.typeChambre}` : ""}`];
          }),
          ["Nuits au total", hotelsNeufs.length ? String(totalNuits) : null],
        ]),
        warnings,
        libelleBouton: `Créer ${voyagesNeufs.length + hotelsNeufs.length} fiche${voyagesNeufs.length + hotelsNeufs.length > 1 ? "s" : ""}`,
      },
      args: {
        parent: d.nature, parentId: d.id, lien: d.lien,
        posteV: posteV?.id ?? null, posteH: posteH?.id ?? null,
        budgetV: budgetV !== null ? String(budgetV) : null, budgetH: budgetH !== null ? String(budgetH) : null,
        voyages: JSON.stringify(voyagesNeufs), hotels: JSON.stringify(hotelsNeufs),
      },
    };
  },

  async executer(a) {
    const voyages = JSON.parse(a.voyages ?? "[]") as FicheVoyage[];
    const hotels = JSON.parse(a.hotels ?? "[]") as FicheHotel[];
    const creerPoste = async (kind: "TICKETING" | "ACCOMMODATION", label: string, budget: string | null): Promise<string | { erreur: string }> => {
      const fd = new FormData();
      fd.set("parent", a.parent!); fd.set("parentId", a.parentId!); fd.set("label", label); fd.set("kind", kind); fd.set("budgetKind", "INCLUDED");
      if (budget) fd.set("amountEstimated", budget);
      const r = await addAdProItem(undefined, fd);
      return r.ok && r.id ? r.id : { erreur: r.error ?? `Le poste « ${label} » n'a pas pu être créé.` };
    };
    let posteV = a.posteV;
    let posteH = a.posteH;
    if (voyages.length && !posteV) { const p = await creerPoste("TICKETING", "Billetterie", a.budgetV); if (typeof p !== "string") return { ok: false, error: p.erreur }; posteV = p; }
    if (hotels.length && !posteH) { const p = await creerPoste("ACCOMMODATION", "Hôtellerie", a.budgetH); if (typeof p !== "string") return { ok: false, error: p.erreur }; posteH = p; }
    const echecs: string[] = [];
    for (const v of voyages) {
      const fd = new FormData();
      fd.set("itemId", posteV!);
      for (const [k, val] of Object.entries(v)) if (val) fd.set(k, String(val));
      const r = await ajouterVoyageur(undefined, fd);
      if (!r.ok) echecs.push(`${v.nom} (voyage) : ${r.error}`);
    }
    for (const h of hotels) {
      const fd = new FormData();
      fd.set("itemId", posteH!);
      for (const [k, val] of Object.entries(h)) if (val) fd.set(k, String(val));
      const r = await ajouterHebergement(undefined, fd);
      if (!r.ok) echecs.push(`${h.nom} (hôtel) : ${r.error}`);
    }
    const faites = voyages.length + hotels.length - echecs.length;
    if (!faites) return { ok: false, error: `Aucune fiche créée : ${echecs.join(" ; ")}` };
    return {
      ok: true, link: a.lien ?? "/ad-pro", revalidate: [a.lien ?? "/ad-pro"],
      message: `${faites} fiche(s) créée(s) sur la demande.${echecs.length ? ` Non créée(s) : ${echecs.join(" ; ")}.` : ""} Annulable en un geste.`,
    };
  },
};
