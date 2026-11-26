locals {
  compartment_ocid = var.compartment_ocid != "" ? var.compartment_ocid : var.tenancy_ocid
  tags             = { app = "mail-me" }
}

resource "oci_core_vcn" "this" {
  compartment_id = local.compartment_ocid
  display_name   = "${var.display_name}-vcn"
  cidr_blocks    = ["10.0.0.0/16"]
  dns_label      = "mailme"
  freeform_tags  = local.tags
}

resource "oci_core_internet_gateway" "this" {
  compartment_id = local.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.display_name}-igw"
  enabled        = true
  freeform_tags  = local.tags
}

resource "oci_core_route_table" "this" {
  compartment_id = local.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.display_name}-routes"
  freeform_tags  = local.tags

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.this.id
  }
}

# mail-me only makes outbound connections (IMAP, HTTPS, SMTP, Telegram), so the only inbound
# rule is SSH for you.
resource "oci_core_security_list" "this" {
  compartment_id = local.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.display_name}-ssh-only"
  freeform_tags  = local.tags

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  ingress_security_rules {
    description = "SSH"
    source      = var.ssh_source_cidr
    protocol    = "6" # TCP
    tcp_options {
      min = 22
      max = 22
    }
  }

  # Path MTU discovery ("fragmentation needed"), as in OCI's default security list.
  ingress_security_rules {
    description = "ICMP fragmentation needed"
    source      = "0.0.0.0/0"
    protocol    = "1" # ICMP
    icmp_options {
      type = 3
      code = 4
    }
  }
}

resource "oci_core_subnet" "this" {
  compartment_id             = local.compartment_ocid
  vcn_id                     = oci_core_vcn.this.id
  display_name               = "${var.display_name}-public"
  cidr_block                 = "10.0.0.0/24"
  dns_label                  = "public"
  route_table_id             = oci_core_route_table.this.id
  security_list_ids          = [oci_core_security_list.this.id]
  prohibit_public_ip_on_vnic = false
  freeform_tags              = local.tags
}
