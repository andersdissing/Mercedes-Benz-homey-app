'use strict';

/**
 * Read the number out of an attribute's display value.
 *
 * mbapi2020 shows several trip figures - consumption and distance since
 * start or reset - from `display_value`, the figure the Mercedes app shows,
 * rather than from the attribute's numeric field. That figure is text, and
 * nothing guarantees how it is written: the account's locale decides the
 * decimal separator, and a distance can carry a thousands separator. A bare
 * `replace(',', '.')` reads "1,430.7" as 1.43, so:
 *
 *   - both separators present: the last one is the decimal point
 *   - commas only: thousands if every group after one is three digits
 *     ("1,430"), a decimal comma otherwise ("21,5")
 *   - dots only: thousands if there is more than one ("1.430.250"), a
 *     decimal point otherwise
 *
 * @returns {Number} the value, or NaN if there is no number in it
 */
function parseDisplayNumber(shown) {
  if (typeof shown === 'number') return shown;
  if (shown === undefined || shown === null) return NaN;

  let text = String(shown).replace(/[\s  ]/g, '');
  if (!/^-?[\d.,]+$/.test(text)) return NaN;

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');

  if (lastComma > -1 && lastDot > -1) {
    text = lastComma > lastDot
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (lastComma > -1) {
    text = /^-?\d{1,3}(,\d{3})+$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.');
  } else if (text.indexOf('.') !== lastDot) {
    text = text.replace(/\./g, '');
  }

  return text === '' || text === '-' ? NaN : Number(text);
}

module.exports = { parseDisplayNumber };
