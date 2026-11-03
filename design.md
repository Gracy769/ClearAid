---
name: Invoice Ready
description: A vivid, evidence-first workspace for reviewing invoices before they are sent.
colors:
  primary: "#0057FF"
  primary-deep: "#003087"
  secondary: "#00A8E0"
  tertiary: "#F7C948"
  neutral-bg: "#F4F7FC"
  surface: "#FFFFFF"
  ink: "#101828"
  muted-ink: "#526178"
  border: "#D8E1EF"
  success: "#087F5B"
  success-bg: "#E6F7F0"
  warning: "#A85A00"
  warning-bg: "#FFF4D6"
  danger: "#B4233D"
  danger-bg: "#FFF0F1"
typography:
  display:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "clamp(2rem, 4vw, 3.25rem)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.035em"
  heading:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "normal"
  data:
    fontFamily: "Geist Mono, Consolas, monospace"
    fontSize: "0.9375rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "10px"
  lg: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  section: "48px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "12px 20px"
    height: "48px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary-deep}"
    rounded: "{rounded.md}"
    padding: "12px 20px"
    height: "48px"
  surface-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "24px"
  sandbox-badge:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
---

## Overview

Invoice Ready is a focused workbench for service vendors checking a proposed invoice against purchase-order or statement-of-work terms. Its visual character is confident, bright, and exact: a strong blue navigation band gives the workspace energy, while white work surfaces keep amounts, findings, and evidence easy to inspect.

**The Blue Rail Rule.** Put the strongest blue in navigation, progress, links, and the action the vendor can take next. Keep large reading surfaces white so dense invoice details remain calm and legible.

The workspace is a tool, not a marketing page or a payment-provider sign-in. Preserve Invoice Ready's own name and compact “IR” mark. Do not use another company's logo or suggest that this workspace is an official provider product. There is no login or registration screen in the current flow.

## Colors

### Primary

- **Primary blue** drives the active workflow step, primary action, selected navigation, and important links. Use it in deliberate blocks and strong accents; reserve its deepest shade for dark navigation or high-emphasis text.
- **Bright cyan** is a supporting highlight for extraction, progress, and secondary data emphasis. It must not compete with the primary action.
- **Signal yellow** marks sandbox context and temporary attention. It is not a success color and should never indicate that a payment is complete.

### Neutral

- **Cool near-white** is the page canvas; **white** is the work surface. Keep a clear distinction between the two.
- **Ink** carries headings, invoice values, and essential labels. **Muted ink** is for helper text and secondary metadata.
- **Fine blue-gray borders** separate cards, form groups, tables, and evidence excerpts without enclosing every text element.

### Status

- **Green** means the deterministic checks found no blocker. It never means the invoice has been paid.
- **Amber** means a human should inspect a warning or unresolved source detail.
- **Red** means a blocking mismatch or invalid invoice value needs correction.

Pair each status color with a visible word or icon: READY, REVIEW, or HOLD. Never communicate status by color alone.

## Typography

Use the existing Geist sans family for headings, labels, buttons, and body text. Use Geist Mono only for invoice identifiers, PO numbers when they need alignment, and tabular technical values. Amounts should use tabular numerals so totals do not shift while editing.

**The Amounts-at-a-Glance Rule.** Make the invoice total the strongest data point in the preflight summary. Keep currency codes visible wherever amounts could otherwise be ambiguous.

Use compact uppercase eyebrow labels sparingly to establish a section or workflow context. Form labels remain sentence case and sit directly above their fields. Avoid long runs of all-caps text.

## Layout

### Workspace shell

- Use a clean white top bar with the Invoice Ready mark and product name at left, plus a compact SANDBOX badge at right.
- Beneath it, use a vivid blue workflow rail with three readable stages: **Invoice details → Preflight → PayPal approval**. The active stage is high contrast; completed and upcoming stages remain distinguishable without relying on color alone.
- Keep the working area on a cool near-white canvas with a centered, wide maximum width. The invoice form and preflight result occupy the main column; a narrower evidence and process rail sits alongside them on wide screens.
- Use a clear vertical rhythm: generous space between workflow sections, tighter spacing inside forms, and consistent alignment across field labels and values.

### Responsive behavior

- On wide screens, show the evidence rail beside the invoice work area and keep the main form readable rather than stretched edge to edge.
- On narrow screens, collapse the evidence rail below the preflight result, stack form fields, and turn the workflow rail into a compact stepper.
- Keep the primary action visible near the result it affects. Never pin an approval action over a field, warning, or evidence quote.
- Preserve comfortable touch targets and prevent horizontal scrolling for line items; allow labels to wrap before amounts are clipped.

## Elevation & Depth

The interface is mostly flat. Use a thin border to define a card and a very soft shadow only when a surface needs separation from the canvas. The current task, preflight result, and evidence should read as related parts of one review, not as a pile of floating panels.

Use a subtle blue tint behind active workflow progress or a verified result. Avoid gradients behind long-form content, blurred glass panels, and deep shadows around every card.

## Shapes

Use gently rounded controls and cards. Inputs and buttons share a consistent medium radius; larger review surfaces have a slightly softer corner. Reserve pill shapes for compact state badges such as SANDBOX, READY, and HOLD.

Inputs have a clear neutral border at rest, a vivid blue focus ring, and distinct invalid styling with both color and an inline message. Do not use a fully rounded capsule shape for ordinary text fields.

## Components

### Navigation and workflow

- The blue workflow rail gives orientation, not a second brand logo. Highlight the current step with a high-contrast marker and a clear text label.
- The SANDBOX badge remains visible in every state that can create or send an invoice.

### Invoice form

- Group vendor, buyer, PO, and currency details into a compact identity section; keep line items in a separate section with aligned description, quantity, and rate columns.
- Keep labels visible after values are entered. Placeholder text is an example, never the only label.
- Show the total near the line items and repeat it in the preflight summary so the amount is easy to verify before approval.

### Preflight and evidence

- Give READY, REVIEW, and HOLD a text label, a distinct icon, and the matching semantic color.
- Put blocking findings before warnings. State the field or line that needs attention and offer a direct path back to it.
- Render evidence quotes as readable excerpts with document name and page, when available. Keep the source detail visually quieter than the finding it supports.
- Keep AI-extracted values editable and label them as suggestions until the vendor reviews them. Never style an extraction suggestion as a system-verified fact.

### Approval actions

- Use one vivid primary button for **Approve & create PayPal draft** only when the preflight is ready.
- Present **Approve & send invoice** as a distinct later action after draft creation, with an explicit sent-to-PayPal confirmation state.
- Use a white button with a dark outline for secondary actions. Disabled actions remain legible and include the reason they are unavailable.

## Do's and Don'ts

### Do

- Use the strong blue rail and white content surfaces to create immediate hierarchy.
- Keep sandbox context visible next to any action that touches PayPal.
- Make totals, blockers, and approval states scannable at a glance.
- Preserve visible labels, keyboard focus, semantic status text, and sufficient contrast.
- Give evidence room to breathe; a concise cited excerpt is more useful than a decorative chart.

### Don't

- Don't reproduce a payment provider's logo, exact navigation, or account sign-in page.
- Don't add login, sign-up, payment, or account-management screens that the current product does not provide.
- Don't use a brand blue as the only indicator of readiness or approval.
- Don't make AI extraction look like validation or imply that a preflight result guarantees payment.
- Don't add decorative gradients, glass effects, oversized illustrations, or charts that obscure invoice data.
