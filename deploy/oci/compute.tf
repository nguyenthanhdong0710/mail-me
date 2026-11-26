locals {
  shape = "VM.Standard.A1.Flex"
  ads   = data.oci_identity_availability_domains.this.availability_domains
  image = var.image_ocid != "" ? var.image_ocid : try(data.oci_core_images.ubuntu.images[0].id, "")
}

data "oci_identity_availability_domains" "this" {
  compartment_id = var.tenancy_ocid
}

# Newest Canonical Ubuntu 24.04 image that runs on Ampere A1.
data "oci_core_images" "ubuntu" {
  compartment_id           = local.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = local.shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_instance" "this" {
  compartment_id      = local.compartment_ocid
  availability_domain = local.ads[var.availability_domain_index].name
  display_name        = var.display_name
  shape               = local.shape
  freeform_tags       = local.tags

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_in_gbs
  }

  source_details {
    source_type             = "image"
    source_id               = local.image
    boot_volume_size_in_gbs = var.boot_volume_size_in_gbs
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.this.id
    assign_public_ip = true
    hostname_label   = lower(var.display_name)
  }

  metadata = {
    ssh_authorized_keys = trimspace(var.ssh_public_key)
    # No user_data: deploy/linux/install.sh sets the server up over SSH.
  }

  # Destroying the instance also deletes its disk, which holds the database and sign-ins.
  preserve_boot_volume = false

  lifecycle {
    # New Ubuntu images are published often. Without this, a later `terraform apply` would
    # replace the server and lose data/.
    ignore_changes = [source_details[0].source_id]

    precondition {
      condition     = var.memory_in_gbs <= 64 * var.ocpus
      error_message = "A1 allows at most 64 GB of memory per OCPU."
    }
    precondition {
      condition     = var.availability_domain_index < length(local.ads)
      error_message = "availability_domain_index is out of range: this region has ${length(local.ads)} availability domain(s), numbered from 0."
    }
    precondition {
      condition     = local.image != ""
      error_message = "No Canonical Ubuntu 24.04 image for VM.Standard.A1.Flex was found in this region. Set image_ocid."
    }
  }
}
