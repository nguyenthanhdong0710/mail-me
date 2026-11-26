# Non-secret inputs only. Never add a variable for a password, API key, OAuth client secret or
# sign-in: those are uploaded with push-config.sh and must not end up in Terraform state.

# --- Where to create it (Resource Manager fills these three in automatically) ---

variable "tenancy_ocid" {
  description = "OCID of your tenancy (Profile menu → Tenancy)."
  type        = string

  validation {
    condition     = startswith(var.tenancy_ocid, "ocid1.tenancy.")
    error_message = "tenancy_ocid must start with \"ocid1.tenancy.\"."
  }
}

variable "compartment_ocid" {
  description = "Compartment to create everything in. Empty means the root compartment (the tenancy)."
  type        = string
  default     = ""

  validation {
    condition     = var.compartment_ocid == "" || startswith(var.compartment_ocid, "ocid1.")
    error_message = "compartment_ocid must be empty or start with \"ocid1.\"."
  }
}

variable "region" {
  description = "Your home region, e.g. eu-frankfurt-1. Always Free compute only exists there."
  type        = string

  validation {
    condition     = length(trimspace(var.region)) > 0
    error_message = "region must not be empty."
  }
}

# --- Access ---

variable "ssh_public_key" {
  description = "SSH public key (the contents of e.g. ~/.ssh/id_ed25519.pub) for the ubuntu user."
  type        = string

  validation {
    condition     = can(regex("^(ssh-|ecdsa-)", trimspace(var.ssh_public_key)))
    error_message = "ssh_public_key must be an OpenSSH public key starting with \"ssh-\" or \"ecdsa-\"."
  }
}

variable "ssh_source_cidr" {
  description = "Who may connect over SSH. Default is anywhere; set it to your own IP, e.g. 203.0.113.7/32."
  type        = string
  default     = "0.0.0.0/0"

  validation {
    condition     = can(cidrnetmask(var.ssh_source_cidr))
    error_message = "ssh_source_cidr must be a valid IPv4 CIDR such as 203.0.113.7/32."
  }
}

# --- Size (kept inside the Always Free allowance) ---

variable "ocpus" {
  description = "Ampere A1 OCPUs. Always Free allows 4 in total per account."
  type        = number
  default     = 1

  validation {
    condition     = var.ocpus >= 1 && var.ocpus <= 4 && floor(var.ocpus) == var.ocpus
    error_message = "ocpus must be a whole number from 1 to 4 (the Always Free A1 total)."
  }
}

variable "memory_in_gbs" {
  description = "Memory in GB. Always Free allows 24 GB of A1 memory in total per account."
  type        = number
  default     = 6

  validation {
    condition     = var.memory_in_gbs >= 1 && var.memory_in_gbs <= 24
    error_message = "memory_in_gbs must be from 1 to 24 (the Always Free A1 total)."
  }
}

variable "boot_volume_size_in_gbs" {
  description = "Boot disk in GB. Always Free allows 200 GB of block storage in total per account."
  type        = number
  default     = 50

  validation {
    condition     = var.boot_volume_size_in_gbs >= 50 && var.boot_volume_size_in_gbs <= 200
    error_message = "boot_volume_size_in_gbs must be from 50 (the image minimum) to 200 (the Always Free total)."
  }
}

variable "availability_domain_index" {
  description = "Which availability domain to use (0, 1 or 2). Try another one on \"Out of host capacity\"."
  type        = number
  default     = 0

  validation {
    condition     = var.availability_domain_index >= 0 && floor(var.availability_domain_index) == var.availability_domain_index
    error_message = "availability_domain_index must be a whole number, 0 or more."
  }
}

variable "image_ocid" {
  description = "Image to boot. Empty picks the newest Canonical Ubuntu 24.04 image for A1."
  type        = string
  default     = ""

  validation {
    condition     = var.image_ocid == "" || startswith(var.image_ocid, "ocid1.image.")
    error_message = "image_ocid must be empty or start with \"ocid1.image.\"."
  }
}


variable "display_name" {
  description = "Name prefix for the created resources and the server's hostname."
  type        = string
  default     = "mail-me"

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]{0,62}$", var.display_name))
    error_message = "display_name must be 1-63 characters: letters, digits and -, starting with a letter."
  }
}
