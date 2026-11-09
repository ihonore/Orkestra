# Gobadiz campaign

Beauty professionals in France for Gobadiz: braiders, nail technicians, lash and brow artists,
make-up artists, barbers, beauty institutes, hair salons and wellness massage. The first run
covers Paris's 20 arrondissements. Île-de-France and the big cities come later.

This folder is a complete, separate gms project. It has its own settings, its own city and
service lists, its own database (`data/`, git-ignored) and its own Google Sheet. Nothing is
shared with the main (US) campaign at the repository root.

## Running it

On the Mac:

```bash
npm run gobadiz            # the dashboard, on http://127.0.0.1:4601
```

Everything else works as in the main README, with `--campaign gobadiz` in front of the command:

```bash
gms --campaign gobadiz db migrate        # first time: creates data/ and loads seeds/
gms --campaign gobadiz plan              # 20 arrondissements x 18 search terms = 360 searches
gms --campaign gobadiz run --workers 2
gms --campaign gobadiz enrich emails
gms --campaign gobadiz qualify           # what is wanted, what is left out and why
gms --campaign gobadiz export sheets
```

While a dashboard task runs, the Mac is kept awake (`caffeinate`), so a scrape is not frozen by
the laptop going to sleep. The lid must stay open, though.

On Windows, later: `scripts\windows\start-dashboard.cmd gobadiz 4601`.

## Choosing where to search

**Cities page.** Every arrondissement is listed. Pause the ones the team is not ready to call
yet, and switch them on as you go. A list left sitting for months goes stale. Collecting only
what you will use is also what the CNIL asks for (data minimisation).

**Services page.** The 18 search terms, weighted in priority order. Braids, afro hair and locks
come first; hair salons and massage come last. A higher weight is searched first in every active
arrondissement.

**Suburbs.** A search in Paris 20e also finds salons in Montreuil. They are kept in the database
but held back ("Hors zone") until a city in their département is active. To open the 93, add
a Seine-Saint-Denis city on the Cities page (département `93`). The salons already found there
are released at the next qualification, with no re-scrape.

To add a whole département, add rows to `seeds/cities.csv`:
- `Zip` is the postcode.
- `City` is the commune name.
- `State Code` is the département.
- Centre coordinates and population come from <https://geo.api.gouv.fr>.

Then run `gms --campaign gobadiz seeds load`.

## Who is left out

`gms --campaign gobadiz qualify` reports every reason. The rules live in two files in this
folder. Edit them, then run `qualify` again: the change applies to everything already found.

- **`exclusions.yaml`**: chain names (Franck Provost, Jean Louis David, Body Minute…) and
  name keywords: hotel spa and thalasso, medical aesthetics, tattoo and piercing, erotic massage.
  Names are matched without accents, case or punctuation, as whole words.
- **`categories.csv`**: each Google category (Maps is read in English) with its French label,
  its Gobadiz specialty, and an exclusion reason where needed (shops, schools, tattoo, medical,
  paramedical). Blank specialty means "take it from the search that found the business".
  `qualify` lists the categories it has not seen yet. Add them here.

These are also left out:
- **Chains no list names.** Three or more listings sharing one website are treated as a chain.
- **Closed salons.** Listings marked permanently closed.

Laser hair removal is **kept**: the Gobadiz catalogue offers "Épilation définitive (laser, lumière
pulsée)". Only doctors, injections and clinics count as medical aesthetics.

## The sheet

Create a **new** Google Sheet for Gobadiz. Share it as Editor with the same service account as
the main campaign, or another one. Then open the dashboard's Google Sheets step and paste the
link. The layout is already set to "One row per qualified lead (French)", writing to the tab
**Prospects**. The full service-account walkthrough is in [docs/GOOGLE_SHEETS.md](../../docs/GOOGLE_SHEETS.md).

Each salon appears **once**, as soon as it is wanted and its website has been checked for an
email. Salons with no email are included: the phone and Instagram are often all there is.
Rows are only ever **added**, never rewritten. The team can sort, filter and fill in **Statut** and
**Notes** freely.

| Column | Meaning |
| --- | --- |
| Priorité | **A**: no online booking yet, and an Instagram or a mobile (06/07) number, i.e. an independent you can reach directly. **B**: no online booking yet. **C**: already books through Planity, Treatwell, its own site, etc. |
| Spécialité | Coiffure, Barbier, Onglerie, Esthétique, Maquillage or Massage, as in the Gobadiz catalogue |
| Nom, Catégorie | The listing's name, and its Google category in French |
| Ville, Code postal, Adresse | "Paris 11e", as Gobadiz writes cities |
| Téléphone, Portable | French format; "oui" for a mobile |
| Email, Autres emails | The best address first (a person's before contact@, the salon's own domain before gmail) |
| Instagram | From the listing or the salon's website |
| Site web | Empty when the "website" is really a Planity, Treatwell or Instagram page |
| Réservation en ligne | Planity, Treatwell, Fresha, Booksy, Iwana, Glaura, ClicRDV…, "Site du salon" for its own booking page; empty if none was seen |
| Sur RDV | "oui" when the name or website says it works by appointment only |
| Note | Google rating. **There is no review count:** Google does not show one on French listings. |
| Trouvé via | The search and arrondissement that found it |
| Statut, Notes | Blank, for the team |

## Opt-outs

Anyone who asks not to be contacted again, by email or on the phone, goes on the opt-out list.
Use the box at the bottom of the dashboard's **Leads** page, or:

```bash
gms --campaign gobadiz suppress add contact@monsalon.fr "06 12 34 56 78" monsalon.fr
gms --campaign gobadiz suppress list
```

They are left out of every export from then on. Rows already in the sheet stay there, so mark
them in **Statut**.

## The rules for contacting French professionals

*Not legal advice. Have the first email and the call script checked.*

- **Email, SMS and WhatsApp to a professional** are allowed without prior consent when the message
  concerns their professional activity, which Gobadiz does (CNIL, B2B prospecting). Every message
  must identify Gobadiz and offer a free, easy way to object, such as an unsubscribe link or
  "répondez STOP".
- **Say where the data came from.** The contacts were not collected from the people themselves,
  so the GDPR (art. 14) requires telling them, at the latest in the first message, that their
  professional details were taken from their public Google Maps listing or their website.
  Include who Gobadiz is, why it is writing, and that they can object. One short paragraph at
  the bottom of the first email does it.
- **Independents are people.** An auto-entrepreneur's gmail or 06 number is personal data. Keep
  only what the sheet needs, and use it only for this outreach.
- **Phone calls** to a pro about their professional activity are B2B. The consumer
  cold-calling rules (Bloctel and what replaced it) are about consumers. A "ne m'appelez plus"
  still goes on the opt-out list.
- **Retention:** the CNIL's benchmark is three years from collection, or from the last contact
  with a prospect who never replied. Delete what is older.
