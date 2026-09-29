// What the quote builder shows for each trade, so a junk-removal quote is not cluttered with roofing tools.
// kinds = extra "+ ..." line buttons (Custom line is always there); measure = helper modes; packages = Good/Better/Best.
// Unknown or older businesses get the plain default. Everything stays available through the price list.
const DEFAULT = { units: ['each', 'job', 'hr', 'ft', 'sq ft'], kinds: ['fee', 'discount'], measure: ['area'], packages: false };
export const TRADE_UI = {
  fence: { units: ['ft', 'each', 'job', 'sq ft', 'hr'], kinds: ['fee', 'discount', 'surcharge'], measure: ['run', 'area'], packages: false },
  roofing: { units: ['sq', 'sq ft', 'ft', 'each', 'job', 'sheet', 'hr'], kinds: ['fee', 'discount', 'surcharge', 'allowance'], measure: ['roof', 'area'], packages: true },
  lawn: { units: ['visit', 'sq ft', 'yd', 'each', 'job', 'hr'], kinds: ['fee', 'discount'], measure: ['area'], packages: false },
  'pressure-washing': { units: ['sq ft', 'ft', 'job', 'hr', 'each'], kinds: ['fee', 'discount', 'surcharge'], measure: ['area', 'run'], packages: false },
  plumbing: { units: ['job', 'each', 'hr', 'ft', 'visit'], kinds: ['labor', 'fee', 'surcharge', 'discount'], measure: [], packages: true },
  electrical: { units: ['job', 'each', 'hr', 'ft'], kinds: ['labor', 'fee', 'surcharge', 'discount'], measure: ['run'], packages: false },
  hvac: { units: ['job', 'each', 'hr', 'lb', 'visit'], kinds: ['labor', 'fee', 'surcharge', 'discount'], measure: [], packages: true },
  painting: { units: ['sq ft', 'ft', 'each', 'job', 'hr', 'day'], kinds: ['allowance', 'labor', 'fee', 'surcharge', 'discount'], measure: ['area', 'run'], packages: true },
  'junk-removal': { units: ['load', 'each', 'hr', 'ton', 'job'], kinds: ['labor', 'fee', 'surcharge', 'discount'], measure: ['load'], packages: false },
  'land-clearing': { units: ['acre', 'hr', 'load', 'each', 'in', 'job'], kinds: ['labor', 'fee', 'discount'], measure: ['acre', 'load'], packages: false },
  'tree-service': { units: ['each', 'in', 'hr', 'job'], kinds: ['labor', 'fee', 'surcharge', 'discount'], measure: [], packages: false },
  handyman: { units: ['hr', 'each', 'job', 'day'], kinds: ['labor', 'allowance', 'fee', 'discount'], measure: ['area'], packages: false },
  concrete: { units: ['sq ft', 'ft', 'each', 'job', 'yd'], kinds: ['fee', 'discount'], measure: ['area', 'run'], packages: false },
  'general-contractor': { units: ['sq ft', 'ft', 'each', 'job', 'day', 'hr'], kinds: ['labor', 'allowance', 'fee', 'surcharge', 'discount'], measure: ['area'], packages: true },
  'pest-control': { units: ['visit', 'job', 'each', 'ft', 'hr'], kinds: ['labor', 'fee', 'discount'], measure: ['area'], packages: false },
};
export const tradeUi = (preset) => TRADE_UI[preset] ?? DEFAULT;
