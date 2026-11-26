terraform {
  # 1.7+ for mock_provider in `terraform test`.
  required_version = ">= 1.7"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
  }
}
