# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-01-10

### Added

- Initial release
- **Importers**: Fio banka (OFX + JSON API), Revolut CSV, generic OFX, manual TypeScript entries
- **Output**: Beancount ledger generation with multi-currency support
- **Rules engine**: Pattern-based transaction categorization (matchName, matchMemo, matchMetadata, matchFn)
- **Override system**: Post-import corrections without modifying raw data
- **Balance assertions**: Automatic verification against bank statements
- **Split transactions**: Divide single transactions across multiple categories
- **Payee locations**: Geographic spending tracking
- **Example data**: Complete working examples for quick start
- **CI**: GitHub Actions workflow for typecheck, lint, and test
