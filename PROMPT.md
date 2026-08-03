
I want you to act as a senior software architect and senior full-stack engineer.

Your goal is to design and build a production-ready Google Maps automation platform that completely replaces my previous RTILA automation.

This is not simply another scraper. The goal is to build a long-term, maintainable automation platform that is:

- robust
- modular
- scalable
- independent of RTILA or any automation software
- easy to extend with future automations
- eventually usable as a SaaS product.

Don't blindly reproduce my existing implementation if there is a better architecture.

Instead, analyze my current workflow, identify weaknesses, and propose a better design.

---

# Existing System

The previous implementation was built using RTILA.

The workflow was:

Google Sheets
↓
Read next city
↓
Read next business category
↓
Search Google Maps
↓
Scroll until all listings are loaded
↓
Open every listing
↓
Extract business information
↓
Visit business website
↓
Crawl website
↓
Extract all email addresses
↓
Save results
↓
Mark city/category as completed
↓
Continue

---

# Existing Files

I am providing several files in the assets folder.

## 1. Google Sheet export

Copy Google Map Email Scrapping Testing.xlsx

This contains the existing data structure.

It includes three sheets:

- Scrapped_Data
- Services
- Cities

The Cities sheet contains city names together with latitude and longitude.

Services contains business categories.

Each city/category is marked as DONE after processing.

Please inspect this spreadsheet and understand the workflow.

---

## 2. Google Apps Script

appscriptcode.js

This is my old Apps Script backend.

It exposes endpoints that RTILA called for reading and writing Google Sheets.

It was designed for multiple automations, not only Google Maps.

Analyze it to understand the workflow.

---

## 3. RTILA Custom Command

rtila-gsheet-custom-command.js

This is the JavaScript custom command RTILA used for communicating with Apps Script.

---

## 4. RTILA Automation

GMAP EMAIL OUTREACH new_03-08-2026___12_34.rtila

This is the exported RTILA workflow.

Analyze it carefully.

Do not reproduce it exactly.

Instead, understand what it does and design a much better implementation.

---

# Primary Use Case

The first automation to build is Google Maps email scraping.

Workflow:

1. Read next city.
2. Read next category.
3. Open Google Maps.
4. Search:

<Category></category> in <City></city>

Example:

Business Broker in Dallas

5. Scroll until either:

- all listings are loaded

or

- configurable maximum number of listings is reached.

6. Open every listing.
7. Extract:

- Business name
- Category
- Rating
- Reviews
- Address
- Phone
- Website
- Google Maps URL
- Coordinates
- Opening hours
- Any additional useful metadata

8. Visit the business website.
9. Crawl the website.

The crawler depth should be configurable.

Examples:

depth = 1

depth = 2

depth = unlimited

10. Extract every valid email address.

Remove duplicates.

Ignore obvious junk emails where appropriate.

11. Save results continuously.

The scraper must never lose progress if interrupted.

---

# Storage

I want storage to be abstract.

It should support multiple providers.

Initially:

- CSV
- Google Sheets

Later it should be easy to add:

- PostgreSQL
- MySQL
- Airtable
- APIs

The scraper should not care where data is stored.

---

# Configuration

Everything should be configurable.

Examples:

- headless/headful
- max businesses
- infinite scrolling
- crawl depth
- concurrency
- worker count
- proxy
- user agent
- delays
- retries
- output format

---

# Long-Term Vision

This should become a generic automation framework.

Google Maps is only the first automation.

Future automations might include:

- LinkedIn
- Yellow Pages
- Company websites
- Facebook
- Directories
- AI enrichment
- CRM integrations

The architecture should make adding new automations straightforward.

---

# Technical Requirements

Choose the best technologies.

Do not assume Node.js if you believe another stack is better.

Explain your reasoning.

Prioritize:

- maintainability
- scalability
- robustness
- testability
- developer experience

---

# Development Process

Do NOT start coding immediately.

First:

1. Analyze every file I provided.
2. Explain how the existing system works.
3. Identify weaknesses.
4. Design a new architecture.
5. Explain trade-offs.
6. Recommend the technology stack.
7. Produce a development roadmap.

Only after I approve the architecture should we begin implementation.

Implement the project incrementally, committing one logical module at a time.

Each module must be production-ready before moving to the next.
