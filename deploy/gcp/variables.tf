# Non-secret inputs only. Never add a variable for a password, API key, OAuth client secret or
# sign-in: those are uploaded with deploy/linux/push-config.sh and must not end up in state.

variable "project_id" {
  description = "Your Google Cloud project ID (not the name), e.g. mail-me-123456."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a Google Cloud project ID: 6-30 lowercase letters, digits or -, starting with a letter."
  }
}

variable "region" {
  description = "One of the free tier regions: us-west1 (Oregon), us-central1 (Iowa) or us-east1 (South Carolina)."
  type        = string
  default     = "us-central1"

  validation {
    condition     = contains(["us-west1", "us-central1", "us-east1"], var.region)
    error_message = "region must be us-west1, us-central1 or us-east1: the free tier e2-micro only exists there."
  }
}

variable "zone" {
  description = "Zone inside the region. Empty picks us-west1-b, us-central1-a or us-east1-b."
  type        = string
  default     = ""

  validation {
    condition     = var.zone == "" || can(regex("^us-(west1|central1|east1)-[a-z]$", var.zone))
    error_message = "zone must be empty or a zone in a free tier region, e.g. us-central1-a."
  }
}

variable "ssh_user" {
  description = "User name to create on the server for your SSH key."
  type        = string
  default     = "ubuntu"

  validation {
    condition     = can(regex("^[a-z_][a-z0-9_-]{0,31}$", var.ssh_user))
    error_message = "ssh_user must be a Linux user name: lowercase letters, digits, _ or -."
  }
}

variable "ssh_public_key" {
  description = "SSH public key (the contents of e.g. ~/.ssh/id_ed25519.pub)."
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

variable "disk_size_gb" {
  description = "Boot disk size. The free tier includes 30 GB of standard persistent disk."
  type        = number
  default     = 30

  validation {
    condition     = var.disk_size_gb >= 10 && var.disk_size_gb <= 30 && floor(var.disk_size_gb) == var.disk_size_gb
    error_message = "disk_size_gb must be a whole number from 10 to 30: the free tier includes 30 GB of standard disk."
  }
}

variable "display_name" {
  description = "Name for the server and its network resources."
  type        = string
  default     = "mail-me"

  validation {
    condition     = can(regex("^[a-z]([-a-z0-9]{0,50}[a-z0-9])?$", var.display_name))
    error_message = "display_name must be lowercase letters, digits and -, starting with a letter (max 52 characters)."
  }
}
